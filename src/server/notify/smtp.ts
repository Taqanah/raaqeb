/**
 * The email channel's SMTP transport over nodemailer: one message over one connection, STARTTLS required or TLS
 * from the first byte with the certificate always verified, AUTH only over
 * a protected connection. nodemailer is imported only when an email channel
 * sends over SMTP, so an install without one never loads it (about 25 MB).
 * Its errors are turned into the ones the base maps onto the reason
 * dictionary: a reply code outside 2xx, a timeout, or the socket's own code.
 */
// biome-ignore lint/style/noRestrictedImports: nodemailer drives a node:net socket, and Bun.connect gives none it can take
import { Socket } from "node:net";
import type { MailMessage, SmtpServer } from "./channel.ts";

/** A reply code outside 2xx from the server, with the reply's text. */
export class SmtpReplyError extends Error {
  readonly code: number;
  constructor(code: number, text: string) {
    super(text);
    this.name = "SmtpReplyError";
    this.code = code;
  }
}

/** An SMTP wait nodemailer ended that names what the server did: it never sent its greeting, or it went quiet during the send. */
export class SmtpTimeoutError extends Error {
  readonly kind: "greeting" | "stalled";
  constructor(kind: "greeting" | "stalled", text: string) {
    super(text);
    this.name = "SmtpTimeoutError";
    this.kind = kind;
  }
}

/** nodemailer starts its quiet-socket timer and its greeting timer together; at the same length they race, and a server that never greets read as stalled in every rerun. The socket's is this much longer, so the greeting is the one that fires. */
const raceMarginMs = 250;

/** The error as the channel base reads it: a refusal by its reply code, a timeout by the wait it ended (`timeoutType`), anything else by the socket's own code, which nodemailer keeps as `originalCode` under its own. */
function normalized(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof DOMException) {
    return error;
  }
  if ("responseCode" in error && typeof error.responseCode === "number") {
    return new SmtpReplyError(error.responseCode, error.message);
  }
  if ("timeoutType" in error) {
    if (error.timeoutType === "GREETING_TIMEOUT") {
      return new SmtpTimeoutError("greeting", error.message);
    }
    if (error.timeoutType === "SOCKET_TIMEOUT") {
      return new SmtpTimeoutError("stalled", error.message);
    }
    // Connecting and the TLS upgrade say no more than that time ran out.
    return new DOMException(error.message, "TimeoutError");
  }
  return "originalCode" in error && typeof error.originalCode === "string"
    ? Object.assign(new Error(error.message), { code: error.originalCode })
    : error;
}

/** Sends one message and closes the connection, giving up at `timeoutMs`; rejects with an `SmtpReplyError` for a refusal, an `SmtpTimeoutError` when the server never greeted or then stayed quiet for `waitMs`, or the connection's own error. */
export async function sendSmtp(
  server: SmtpServer,
  message: MailMessage,
  timeoutMs: number,
  waitMs: number
): Promise<void> {
  const { createTransport } = await import("nodemailer");
  const { address, name } = message.from;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  // The attempt owns the socket, so a failed one closes it even when nodemailer still waits on the server.
  const socket = new Socket();
  const transport = createTransport({
    // AUTH never crosses a plain connection, whoever calls.
    auth:
      server.username === undefined || server.security === "none"
        ? undefined
        : { pass: server.password ?? "", user: server.username },
    connectionTimeout: waitMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    host: server.host,
    // Without STARTTLS, nodemailer would take a server's word that it has none and send the password in clear.
    ignoreTLS: server.security === "none",
    // The EHLO name; nodemailer's own is the host's name, which it would leak.
    name: domain,
    port: server.port,
    requireTLS: server.security === "starttls",
    secure: server.security === "tls",
    socket,
    socketTimeout: waitMs + raceMarginMs,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // nodemailer has no overall timeout, only one per phase; the attempt has one, longer than each of nodemailer's waits (`waitMs`), so a wait nodemailer ends names itself and the deadline catches a server that trickles, goes quiet late or has a lookup that never ends.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new DOMException("the SMTP attempt timed out", "TimeoutError")),
      timeoutMs
    );
  });
  try {
    const info = await Promise.race([
      transport.sendMail({
        from: name === undefined ? address : { address, name },
        headers: { ...message.headers },
        html: message.html,
        messageId: `<${message.id}@${domain}>`,
        subject: message.subject,
        text: message.text,
        textEncoding: "base64",
        to: [...message.to],
      }),
      deadline,
    ]);
    // Some recipients refused: the notification did not reach everyone, so it is a failed attempt.
    const [refused] = info.rejectedErrors ?? [];
    if (info.rejected.length > 0) {
      throw refused ?? new SmtpReplyError(550, "a recipient was refused");
    }
  } catch (error) {
    throw normalized(error);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
