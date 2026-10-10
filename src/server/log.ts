/**
 * The logging convention: plain text lines, one per event, to
 * standard output, errors to standard error. No level, no timestamp, no JSON;
 * journald and `docker logs` add time and rotation. A line never carries the
 * value of a boot setting, only its name and length. A line break
 * inside a line, as an error's message may hold, becomes a space.
 */

const lineBreak = /\s*[\r\n]+\s*/g;

// The paths whose next segment is a secret: a heartbeat token, a subscription's token, a password reset token.
const tokenSegment =
  /^(\/api\/heartbeat|\/subscriptions|\/api\/auth\/reset-password)\/[^/]+/;

/** A request's path as a line names it: no query, and no token a path carries. */
export function loggedPath(url: string): string {
  return new URL(url).pathname.replace(tokenSegment, "$1/<token>");
}

/** Writes one line to standard output. */
export function info(line: string): void {
  process.stdout.write(`raaqeb: ${line.replaceAll(lineBreak, " ")}\n`);
}

/** Writes one line to standard error. */
export function error(line: string): void {
  process.stderr.write(`raaqeb: ${line.replaceAll(lineBreak, " ")}\n`);
}

/** An error as a line names it. A refused query's message lists every bound value (a capture's headers and body, a token, an address), so a query's failure is its driver's own message, which names the table or the constraint alone. */
export function reasonOf(thrown: unknown): string {
  if (!(thrown instanceof Error)) {
    return "an error that is not an Error";
  }
  if (!thrown.message.startsWith("Failed query")) {
    return thrown.message;
  }
  return thrown.cause instanceof Error ? thrown.cause.message : thrown.name;
}
