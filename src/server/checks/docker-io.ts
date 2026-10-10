/**
 * The Docker check's live I/O: one GET to the daemon's Engine API
 * over Bun's `fetch`, through its `unix` option for a socket's path or to
 * the URL otherwise, the body read to a cap and parsed as JSON. Bun's fetch
 * reports every socket that does not open as `FailedToOpenSocket`, so a
 * socket that failed is opened once more with `Bun.connect`, whose error
 * says whether it is missing, refused or not this process's to open.
 */
import { isSocketPath } from "@/shared/schemas/monitor.ts";
import type { DockerAnswer, DockerRequest } from "./docker.ts";
import { codeOf } from "./errors.ts";
import { readBody } from "./http.ts";

/** The most of an answer the adapter reads: a list of a few thousand containers fits. */
export const dockerAnswerMaxBytes = 4 * 1_048_576;

const trailingSlashes = /\/+$/;

/** Sends the request and answers the daemon's status and JSON body; rejects with the transport's error, or a `TimeoutError` past the timeout. */
export async function requestDocker(
  request: DockerRequest
): Promise<DockerAnswer> {
  const { endpoint, path, timeoutMs } = request;
  const socket = isSocketPath(endpoint);
  // A redirect would leave the daemon; it reads as the status it is.
  const init: BunFetchRequestInit = {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  };
  let response: Response;
  try {
    response = socket
      ? await fetch(`http://localhost${path}`, { ...init, unix: endpoint })
      : await fetch(`${endpoint.replace(trailingSlashes, "")}${path}`, init);
  } catch (error) {
    throw socket && codeOf(error) === "FailedToOpenSocket"
      ? await socketError(endpoint, error)
      : error;
  }
  const body = await readBody(response, { read: 0 }, dockerAnswerMaxBytes + 1);
  if (body.byteLength > dockerAnswerMaxBytes) {
    throw new Error("the Docker endpoint's answer is larger than 4 MB");
  }
  return { body: parseJson(body), status: response.status };
}

/** Why the socket did not open, read from a second try with `Bun.connect`; the first error when that one opens. */
async function socketError(unix: string, first: unknown): Promise<unknown> {
  try {
    const opened = await Bun.connect({
      socket: { data: () => undefined },
      unix,
    });
    opened.end();
    return first;
  } catch (error) {
    const code = codeOf(error);
    return code === undefined
      ? first
      : Object.assign(new Error(`connect ${code} ${unix}`), { code });
  }
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Not JSON: the check reads the status alone.
  }
}
