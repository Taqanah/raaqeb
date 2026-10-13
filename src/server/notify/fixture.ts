/**
 * Test support: a scripted SMTP server on `Bun.listen`, so the SQLite gate
 * runs the email channel's real SMTP path with no Mailpit (Mailpit runs
 * under `bun run test:postgres`). It answers EHLO, MAIL,
 * RCPT, DATA, RSET and QUIT, records what it was told, and can refuse a
 * command with a code of the test's choosing or stay silent. Beside it, a
 * transport that records every POST a channel makes, for the chat channels'
 * recorded samples.
 */
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import type { ChannelPayload, Transport } from "./channel.ts";

/** The monitor every recorded sample reports on. */
export const sampleMonitor = {
  adminUrl: "https://status.example.test/admin/monitors/0199",
  checkType: "http" as const,
  id: "0199",
  name: "API",
  target: "https://api.example.test/health",
};

/** One notification as a channel is handed it, in Arabic in the Riyadh zone unless the test says otherwise. */
export function sampleSend(
  notification: NotificationPayload,
  locale: "ar" | "en" = "ar"
): ChannelPayload {
  return {
    id: "01999a3c-0000-7000-8000-000000000001",
    locale,
    notification,
    time: { calendar: "gregorian", clock: "12h", timeZone: "Asia/Riyadh" },
  };
}

/** A down notification of the sample monitor, with what the test changes on it. */
export function sampleDownOf(
  monitor: Partial<typeof sampleMonitor> & { adminUrl?: string }
): NotificationPayload {
  return {
    data: { monitor: { ...sampleMonitor, ...monitor }, reason: "timeout" },
    timestamp: "2026-09-25T18:49:00.000Z",
    type: "monitor.down",
  };
}

/** The down notification every recorded sample carries. */
export const sampleDown: NotificationPayload = sampleDownOf({});

/** The down notification's chat text in Arabic, as every chat channel's sample carries it before the monitor's link, which each writes in its own markup. */
export const sampleDownText =
  "API: متعطّل\n\nالمراقبة متعطّلة.\n\nالمراقبة: API\nالهدف: https://api.example.test/health\nالعلة: انتهت مهلة الانتظار\nالوقت: 25 سبتمبر 2026، 9:49 م (غرينتش+3)";

/** The open-incident link a down notification may carry. */
export const sampleIncidentUrl =
  "https://status.example.test/admin/incidents/new?monitor=0199";

/** One POST as a channel made it. */
export interface RecordedPost {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

const folded = /\r\n[ \t]+/g;
const encodedWord = /[=]\?UTF-8\?([BQ])\?([^?]*)\?=/gi;
const quotedByte = /[=]([0-9A-F]{2})/gi;
const whitespace = /\s+/g;

/** A message's headers, unfolded, by lower-cased name, and its body. */
export function parse(raw: string): {
  body: string;
  headers: Record<string, string | undefined>;
} {
  const [head = "", ...rest] = raw.split("\r\n\r\n");
  const headers: Record<string, string | undefined> = {};
  for (const line of head.replace(folded, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { body: rest.join("\r\n\r\n"), headers };
}

const betweenWords = /\?=\s+=\?/g;

/** A header's RFC 2047 encoded words read back to their text; the space between two adjacent words is not part of it. */
export function decodeWords(value: string): string {
  return value
    .replace(betweenWords, "?==?")
    .replace(encodedWord, (_, kind: string, text: string) =>
      kind.toUpperCase() === "B"
        ? new TextDecoder().decode(Uint8Array.fromBase64(text))
        : decodeURIComponent(
            text.replaceAll("_", " ").replace(quotedByte, "%$1")
          )
    );
}

interface Parsed {
  readonly body: string;
  readonly headers: Record<string, string | undefined>;
}

const boundaryOf = /boundary="?([^";]+)"?/;
const leadingBreak = /^\r\n/;

/** A multipart message's parts in their order, each parsed; a message of one part is that part. */
export function partsOf(message: Parsed): Parsed[] {
  const boundary = boundaryOf.exec(message.headers["content-type"] ?? "")?.[1];
  if (boundary === undefined) {
    return [message];
  }
  return message.body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => parse(part.replace(leadingBreak, "")));
}

/** A parsed message's part of the type, text/plain by default, as text, decoded when it went as base64. */
export function bodyText(message: Parsed, type = "text/plain"): string {
  const part =
    partsOf(message).find((each) =>
      (each.headers["content-type"] ?? "text/plain").startsWith(type)
    ) ?? message;
  return part.headers["content-transfer-encoding"] === "base64"
    ? new TextDecoder().decode(
        Uint8Array.fromBase64(part.body.replace(whitespace, ""))
      )
    : part.body;
}

const hiddenElements = /<(style|title)[^>]*>[\s\S]*?<\/\1>/g;
const lineEnds = /<\/(td|p|div)>|<br>/g;
const tags = /<[^>]+>/g;
const entities: Readonly<Record<string, string>> = {
  "&#x27;": "'",
  "&amp;": "&",
  "&gt;": ">",
  "&lt;": "<",
  "&quot;": '"',
};
const entity = /&(?:#x27|amp|gt|lt|quot);/g;
const blankRuns = /[ \t]*\n[\s]*/g;
const anchor = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

/** An escaped text read back. */
function unescaped(text: string): string {
  return text.replace(entity, (each) => entities[each] ?? each);
}

/** What an HTML part shows as text, one line per cell, paragraph or break, its tags and the style and title left out. */
export function htmlText(html: string): string {
  return unescaped(
    html.replace(hiddenElements, "").replace(lineEnds, "\n").replace(tags, "")
  )
    .replace(blankRuns, "\n")
    .trim();
}

/** Each link of an HTML part: the address it opens and the words it shows. */
export function htmlLinks(html: string): { url: string; words: string }[] {
  return [...html.matchAll(anchor)].map(([, url = "", words = ""]) => ({
    url: unescaped(url),
    words: htmlText(words),
  }));
}

/** A transport that records every POST, answers each with success, and refuses SMTP. */
export function recordPosts(now = Date.parse("2026-09-25T18:49:05.000Z")): {
  readonly posts: RecordedPost[];
  readonly transport: Transport;
} {
  const posts: RecordedPost[] = [];
  const transport: Transport = {
    now: () => now,
    post: (url, request) => {
      posts.push({ ...request, url });
      return Promise.resolve();
    },
    smtp: () => Promise.reject(new Error("a chat channel sends no mail")),
  };
  return { posts, transport };
}

export interface FakeSmtpOptions {
  /** Never answer this command (by its verb) after the greeting and the EHLO, as a server that goes quiet mid-send. */
  readonly mute?: string;
  /** Offer AUTH PLAIN and LOGIN in the EHLO answer, and accept any credentials. */
  readonly offerAuth?: boolean;
  /** Offer STARTTLS in the EHLO answer; the server cannot upgrade, so a client that asks gets 454 unless `replies.STARTTLS` says otherwise. */
  readonly offerStartTls?: boolean;
  /** Refuse RCPT TO for this one address with 550, and accept the others. */
  readonly refuseRecipient?: string;
  /** The reply to each command by its verb (`MAIL`, `RCPT`, `DATA`, and `.` for the end of a message), instead of the default. */
  readonly replies?: Readonly<Record<string, string>>;
  /** Never send the greeting. */
  readonly silent?: boolean;
  /** Answer EHLO with a reply that never ends: one more line every 20 ms, so the connection is never quiet. */
  readonly trickle?: boolean;
}

export interface FakeSmtp {
  /** Resolves once a connection closed. */
  readonly closed: () => Promise<void>;
  /** Every command line in the order received, the message's lines apart. */
  readonly commands: string[];
  /** Each message's data as received, dot-stuffing undone. */
  readonly messages: string[];
  readonly port: number;
  readonly stop: () => void;
}

/** What ends a command's verb: a space, or the colon of `MAIL FROM:`. */
const verbEnd = /[\s:]/;

interface Session {
  buffer: string;
  data: string[] | undefined;
  /** After a STARTTLS the server agreed to: the handshake's bytes are not commands, and nothing answers them. */
  handshake?: boolean;
  ticker?: ReturnType<typeof setInterval>;
}

export function fakeSmtp(options: FakeSmtpOptions = {}): FakeSmtp {
  const commands: string[] = [];
  const messages: string[] = [];
  let resolveClosed: () => void = () => undefined;
  const closedOnce = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const reply = (verb: string, fallback: string): string =>
    `${options.replies?.[verb] ?? fallback}\r\n`;

  /** One line of a message's data: kept, or the end of the message. */
  const dataLine = (session: Session, data: string[], line: string) => {
    if (line === ".") {
      messages.push(data.join("\r\n"));
      session.data = undefined;
      return reply(".", "250 2.0.0 queued");
    }
    data.push(line.startsWith(".") ? line.slice(1) : line);
  };

  const recipient = (line: string): string =>
    options.refuseRecipient !== undefined &&
    line.includes(`<${options.refuseRecipient}>`)
      ? "550 5.1.1 no such user\r\n"
      : reply("RCPT", "250 2.1.5 ok");

  const answer = (session: Session, line: string): string | undefined => {
    if (session.data) {
      return dataLine(session, session.data, line);
    }
    commands.push(line);
    const verb = line.split(verbEnd)[0]?.toUpperCase() ?? "";
    if (verb === options.mute) {
      return undefined;
    }
    switch (verb) {
      case "EHLO":
        if (options.trickle) {
          return "250-fake.example.test\r\n";
        }
        return [
          "250-fake.example.test",
          ...(options.offerStartTls ? ["250-STARTTLS"] : []),
          ...(options.offerAuth ? ["250-AUTH PLAIN LOGIN"] : []),
          "250 8BITMIME",
          "",
        ].join("\r\n");
      case "AUTH":
        return "235 2.7.0 accepted\r\n";
      case "HELO":
        return "250 fake.example.test\r\n";
      case "STARTTLS": {
        const answered = reply("STARTTLS", "454 4.7.0 TLS not available");
        session.handshake = answered.startsWith("220");
        return answered;
      }
      case "MAIL":
        return reply("MAIL", "250 2.1.0 ok");
      case "RCPT":
        return recipient(line);
      case "DATA": {
        const answered = reply("DATA", "354 go ahead");
        if (answered.startsWith("354")) {
          session.data = [];
        }
        return answered;
      }
      case "RSET":
        return "250 2.0.0 ok\r\n";
      case "QUIT":
        return "221 2.0.0 bye\r\n";
      default:
        return "502 5.5.2 unknown command\r\n";
    }
  };

  const listener = Bun.listen<Session>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      close: (socket) => {
        clearInterval(socket.data.ticker);
        resolveClosed();
      },
      data: (socket, chunk) => {
        if (socket.data.handshake) {
          return;
        }
        socket.data.buffer += chunk.toString();
        let end = socket.data.buffer.indexOf("\r\n");
        while (end !== -1) {
          const line = socket.data.buffer.slice(0, end);
          socket.data.buffer = socket.data.buffer.slice(end + 2);
          const answered = answer(socket.data, line);
          if (answered !== undefined) {
            socket.write(answered);
          }
          if (options.trickle && line.toUpperCase().startsWith("EHLO")) {
            socket.data.ticker = setInterval(
              () => socket.write("250-more\r\n"),
              20
            );
          }
          if (line.toUpperCase() === "QUIT") {
            socket.end();
          }
          end = socket.data.buffer.indexOf("\r\n");
        }
      },
      open: (socket) => {
        socket.data = { buffer: "", data: undefined };
        if (!options.silent) {
          socket.write("220 fake.example.test ESMTP\r\n");
        }
      },
    },
  });

  return {
    closed: () => closedOnce,
    commands,
    messages,
    port: listener.port,
    stop: () => listener.stop(true),
  };
}
