/**
 * The email channel's SMTP transport over nodemailer: one message over one connection, STARTTLS required or TLS
 * from the first byte with the certificate always verified, AUTH only over
 * a protected connection. nodemailer is imported only when an email channel
 * sends over SMTP, so an install without one never loads it (about 25 MB).
 * Its errors are turned into the ones the base maps onto the reason
 * dictionary: a reply code outside 2xx, a timeout, or the socket's own code.
 */
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

/** The error as the channel base reads it: a refusal by its reply code, anything else by the socket's own code, which nodemailer keeps as `originalCode` under its own. */
function normalized(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof DOMException) {
    return error;
  }
  if ("responseCode" in error && typeof error.responseCode === "number") {
    return new SmtpReplyError(error.responseCode, error.message);
  }
  return "originalCode" in error && typeof error.originalCode === "string"
    ? Object.assign(new Error(error.message), { code: error.originalCode })
    : error;
}

/** Sends one message and closes the connection; rejects with an `SmtpReplyError` for a refusal, or the connection's own error. */
export async function sendSmtp(
  server: SmtpServer,
  message: MailMessage,
  timeoutMs: number
): Promise<void> {
  const { createTransport } = await import("nodemailer");
  const { address, name } = message.from;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  const transport = createTransport({
    // AUTH never crosses a plain connection, whoever calls.
    auth:
      server.username === undefined || server.security === "none"
        ? undefined
        : { pass: server.password ?? "", user: server.username },
    connectionTimeout: timeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    dnsTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    host: server.host,
    // Without STARTTLS, nodemailer would take a server's word that it has none and send the password in clear.
    ignoreTLS: server.security === "none",
    // The EHLO name; nodemailer's own is the host's name, which it would leak.
    name: domain,
    port: server.port,
    requireTLS: server.security === "starttls",
    secure: server.security === "tls",
    socketTimeout: timeoutMs,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // nodemailer has no overall timeout, only one per phase; the attempt has one, started before any of nodemailer's, so it is the one that fires.
  // ponytail: a server that trickles keeps its socket open after the attempt fails; drive nodemailer's SMTPConnection to close it if that shows.
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
  }
}
