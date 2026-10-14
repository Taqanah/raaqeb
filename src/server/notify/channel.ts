/**
 * The channel base: a channel type implements `send(config,
 * payload, transport)` and declares its fields (shared/schemas/channel.ts);
 * the base owns the transport, the timeout and the error handling, and the
 * queue owns the retries (queue.ts). A send that throws or times out, an
 * answer outside 2xx and an SMTP refusal are failed attempts with a code
 * from the reason dictionary, and a refused
 * answer's body is kept as the error; a secret never appears in what
 * is recorded. Channels are compiled in; there is no plugin loading.
 */

import { reasonForError } from "@/server/checks/errors.ts";
import type { TimeOptions } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type {
  ChannelDeclaration,
  ChannelValues,
  Sender,
  SmtpSecurity,
} from "@/shared/schemas/channel.ts";
import { errorMaxLength } from "@/shared/schemas/check.ts";
import type {
  NotificationPayload,
  SendFailure,
} from "@/shared/schemas/notification.ts";
import { reasonParamsSchema } from "@/shared/schemas/reason.ts";
import type { HostLookup } from "./destination.ts";
import { SmtpReplyError, SmtpTimeoutError, sendSmtp } from "./smtp.ts";

/** One attempt gives up after this long. */
export const sendTimeoutMs = 10_000;

/** The most of a refused answer's body the base reads; the recorded error keeps its start. */
export const refusedBodyBytes = 1024;

/** The headers of a channel's JSON POST. */
export const jsonHeaders: Readonly<Record<string, string>> = {
  "content-type": "application/json",
  "user-agent": "Raaqeb",
};

/** One SMTP attempt gives up after this long: a relay may hold its greeting for seconds. */
export const smtpTimeoutMs = 30_000;

/** The longest one SMTP wait may take, setting the session up or a quiet socket: under the attempt's limit, so a server that never greets, or goes quiet in the send's first `smtpTimeoutMs - smtpWaitMs` seconds, is named before the limit takes it. */
export const smtpWaitMs = 20_000;

/** The SMTP server an email channel sends through. */
export interface SmtpServer {
  readonly host: string;
  /** Present only over a protected connection, with the user name. */
  readonly password: string | undefined;
  readonly port: number;
  readonly security: SmtpSecurity;
  /** Absent sends no AUTH. */
  readonly username: string | undefined;
}

/** One email: its plain-text part, and the HTML part that shows the same content. */
export interface MailMessage {
  readonly from: Sender;
  /** Headers beside the ones every message has: a subscriber's `List-Unsubscribe` pair (RFC 8058). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly html: string;
  /** The notification's id, the same on every retry; the Message-ID is made from it. */
  readonly id: string;
  readonly subject: string;
  readonly text: string;
  readonly to: readonly string[];
}

/** What a channel sends with: a POST or an SMTP message the base times, and the clock. */
export interface Transport {
  readonly now: () => number;
  /** Resolves on a 2xx answer; rejects on anything else, which the base turns into a failed attempt. Redirects are not followed, so a signed body never lands elsewhere. */
  readonly post: (
    url: string,
    request: {
      /** The address checked before the POST, which it connects to; the URL's host still names the server, in the Host header and the certificate. */
      readonly address?: string;
      readonly body: string;
      readonly headers: Readonly<Record<string, string>>;
    }
  ) => Promise<void>;
  /** Resolves once the server accepted the message; rejects with what refused it. Certificates are always verified. */
  readonly smtp: (server: SmtpServer, message: MailMessage) => Promise<void>;
}

/** What one send carries: the notification's id, which is the same on every retry, its machine payload, and the language its text is written in. */
export interface ChannelPayload {
  readonly id: string;
  readonly locale: Locale;
  readonly notification: NotificationPayload;
  /** The install time zone, clock and calendar the text's times are written in. */
  readonly time: TimeOptions;
}

/** A channel type as the server knows it. */
export interface NotificationChannel {
  readonly declaration: ChannelDeclaration;
  /** Makes the value of each generated field, by the field's name. */
  readonly generate: Readonly<Record<string, () => string>>;
  /** Sends one payload with the channel's values, secrets included; a throw is a failed attempt. */
  readonly send: (
    config: Readonly<Record<string, string>>,
    payload: ChannelPayload,
    transport: Transport
  ) => Promise<void>;
}

export type SendOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: SendFailure };

/** The platform a delivery runs on. */
export interface DeliverIo {
  readonly fetch: typeof fetch;
  /** Resolves a subscriber's webhook host before its POST; the system's resolver when absent. */
  readonly lookup?: HostLookup;
  readonly now: () => number;
}

/** The start of an answer's body, and whether it was cut short. */
interface BodyStart {
  readonly cut: boolean;
  readonly text: string;
}

/** An answer outside 2xx, which the base records as the status it saw, with the start of its body. */
class StatusError extends Error {
  readonly body: BodyStart;
  readonly status: number;
  constructor(status: number, body: BodyStart) {
    super(`the receiver answered ${status}`);
    this.name = "StatusError";
    this.body = body;
    this.status = status;
  }
}

/** The start of an answer's body as text, read no further than `refusedBodyBytes`. */
async function startOf(
  body: ReadableStream<Uint8Array> | null
): Promise<BodyStart> {
  if (!body) {
    return { cut: false, text: "" };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  // Leaving the loop cancels the stream, so the rest is never read.
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= refusedBodyBytes) {
      cut = true;
      break;
    }
  }
  const text = new TextDecoder().decode(Bun.concatArrayBuffers(chunks));
  return { cut, text: text.trim() };
}

/** The URL with its host swapped for the address, and the name the server is still asked by: the Host header and the certificate's name (Bun checks it against `serverName`). Nothing changes without an address, or when the host already is it. */
function pinnedTo(
  url: string,
  address: string | undefined
): {
  readonly headers: Readonly<Record<string, string>>;
  readonly serverName?: string;
  readonly url: string;
} {
  if (address === undefined) {
    return { headers: {}, url };
  }
  const target = new URL(url);
  const { host, hostname } = target;
  const pinned = address.includes(":") ? `[${address}]` : address;
  if (pinned === hostname) {
    return { headers: {}, url };
  }
  target.hostname = pinned;
  return { headers: { host }, serverName: hostname, url: target.href };
}

/** Runs one send over a transport on the platform and answers its outcome, every secret taken out of a failure's text; never throws. Auth mail sends through it without a channel payload. */
export async function attempt(
  io: DeliverIo,
  secrets: readonly string[],
  send: (transport: Transport) => Promise<void>
): Promise<SendOutcome> {
  let target = { host: "", port: 0, timeoutMs: sendTimeoutMs };
  const transport: Transport = {
    now: io.now,
    post: async (url, request) => {
      target = { ...targetOf(url), timeoutMs: sendTimeoutMs };
      const pin = pinnedTo(url, request.address);
      const response = await io.fetch(pin.url, {
        body: request.body,
        headers: { ...request.headers, ...pin.headers },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(sendTimeoutMs),
        ...(pin.serverName === undefined
          ? {}
          : { tls: { serverName: pin.serverName } }),
      });
      if (!response.ok) {
        // A refusal's body often says why: Slack's invalid_token, Telegram's description.
        throw new StatusError(response.status, await startOf(response.body));
      }
      // Nothing in a success is kept, so its body is not read.
      await response.body?.cancel();
    },
    smtp: (server, message) => {
      target = {
        host: server.host,
        port: server.port,
        timeoutMs: smtpTimeoutMs,
      };
      return sendSmtp(server, message, smtpTimeoutMs, smtpWaitMs);
    },
  };
  try {
    await send(transport);
    return { ok: true };
  } catch (error) {
    return { failure: failureOf(error, target, secrets), ok: false };
  }
}

/** Runs one attempt of the channel's send over the transport and answers its outcome; never throws. */
export function deliver(
  channel: NotificationChannel,
  config: Readonly<Record<string, string>>,
  payload: ChannelPayload,
  io: DeliverIo
): Promise<SendOutcome> {
  return attempt(io, secretsOf(channel, config), (transport) =>
    channel.send(config, payload, transport)
  );
}

function failureOf(
  error: unknown,
  target: {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
  },
  secrets: readonly string[]
): SendFailure {
  if (error instanceof StatusError) {
    const whole = withoutSecrets(error.body.text, secrets);
    const text = (
      error.body.cut ? withoutSecretStart(whole, secrets) : whole
    ).slice(0, errorMaxLength);
    return {
      error: text === "" ? undefined : text,
      params: {
        expected: ["2xx"],
        observed: error.status,
        reason: "unexpected_status",
      },
      reason: "unexpected_status",
    };
  }
  // An SMTP refusal: its reply code in place of a status, its text as the error.
  if (error instanceof SmtpReplyError) {
    return {
      error: withoutSecrets(error.message, secrets).slice(0, errorMaxLength),
      params: {
        expected: ["2xx"],
        observed: error.code,
        reason: "unexpected_status",
      },
      reason: "unexpected_status",
    };
  }
  // An SMTP wait that named itself: the server never greeted, or went quiet mid-send.
  if (error instanceof SmtpTimeoutError) {
    const reason =
      error.kind === "greeting" ? "smtp_no_greeting" : "smtp_stalled";
    return {
      error: withoutSecrets(error.message, secrets).slice(0, errorMaxLength),
      params: { reason },
      reason,
    };
  }
  const mapped = reasonForError(error, target);
  const text = withoutSecrets(mapped.error, secrets);
  // A failure is stored and read back through the dictionary; what it cannot hold is unknown, never a row that breaks the reads.
  if (!reasonParamsSchema.safeParse(mapped.params).success) {
    return { error: text, params: { reason: "unknown" }, reason: "unknown" };
  }
  return { error: text, params: mapped.params, reason: mapped.reason };
}

/** The host and port a URL reaches, with the scheme's port when it names none. */
function targetOf(url: string): { host: string; port: number } {
  if (!URL.canParse(url)) {
    return { host: "", port: 0 };
  }
  const parsed = new URL(url);
  const fallback = parsed.protocol === "https:" ? 443 : 80;
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? fallback : Number(parsed.port),
  };
}

/** Every secret value of the channel, and for a secret URL its path and query too, which a driver's text may repeat alone; the longest first. */
export function secretsOf(
  channel: NotificationChannel,
  config: ChannelValues
): string[] {
  const secrets: string[] = [];
  for (const field of channel.declaration.fields) {
    const value = config[field.name];
    if (!field.secret || value === undefined || value === "") {
      continue;
    }
    secrets.push(...urlSecrets(value));
  }
  // The longest first, so a URL is taken out whole before its path.
  return secrets.toSorted((a, b) => b.length - a.length);
}

/** A secret value and, when it is a URL, its path with its query and its query alone, which a receiver's text may repeat without the rest. */
export function urlSecrets(value: string): string[] {
  if (!URL.canParse(value)) {
    return [value];
  }
  const { pathname, search } = new URL(value);
  return [value, `${pathname}${search}`, search].filter(
    (part) => part.length > 1
  );
}

/** A text cut short may end in the start of a secret, which no whole match finds; that tail goes too. */
function withoutSecretStart(text: string, secrets: readonly string[]): string {
  let tail = 0;
  for (const secret of secrets) {
    for (let length = secret.length - 1; length > tail; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        tail = length;
        break;
      }
    }
  }
  return tail === 0 ? text : `${text.slice(0, -tail)}…`;
}

function withoutSecrets(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) {
    clean = clean.replaceAll(secret, "…");
  }
  return clean;
}
