/**
 * The Docker check's live adapter over real sockets in a temp directory and
 * a TCP port: what it sends, what it answers, and the error each way a
 * socket fails gives, which Bun's fetch alone reports as one code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAnswerMaxBytes, requestDocker } from "./docker-io.ts";

let directory = "";
const servers: ReturnType<typeof Bun.serve>[] = [];
const seen: { method: string; path: string }[] = [];

function serve(
  options: { unix: string } | { hostname: string; port: number },
  answer: (request: Request) => Response | Promise<Response>
): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    ...options,
    fetch: (request) => {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
      });
      return answer(request);
    },
  });
  servers.push(server);
  return server;
}

beforeAll(async () => {
  directory = (await Bun.$`mktemp -d`.text()).trim();
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
  await Bun.$`rm -rf ${directory}`.quiet();
});

/** The rejection's code and message, or a note that it resolved. */
async function failure(
  promise: Promise<unknown>
): Promise<{ code: unknown; message: string; name: string }> {
  try {
    await promise;
  } catch (error) {
    const { code, message, name } = error as Error & { code?: unknown };
    return { code, message, name };
  }
  return { code: undefined, message: "resolved", name: "" };
}

describe("a request to the Docker daemon", () => {
  test("sends a GET over the Unix socket and answers the status and the JSON body", async () => {
    const unix = `${directory}/ok.sock`;
    serve({ unix }, () => Response.json([{ Names: ["/web"] }]));
    seen.length = 0;
    const answer = await requestDocker({
      endpoint: unix,
      path: "/containers/json?all=true",
      timeoutMs: 1000,
    });
    expect(seen).toEqual([
      { method: "GET", path: "/containers/json?all=true" },
    ]);
    expect(answer).toEqual({ body: [{ Names: ["/web"] }], status: 200 });
  });

  test("answers an error status with its body", async () => {
    const unix = `${directory}/missing-container.sock`;
    serve({ unix }, () =>
      Response.json({ message: "No such container: web" }, { status: 404 })
    );
    expect(
      await requestDocker({
        endpoint: unix,
        path: "/containers/web/json",
        timeoutMs: 1000,
      })
    ).toEqual({ body: { message: "No such container: web" }, status: 404 });
  });

  test("answers no body when the body is not JSON", async () => {
    const unix = `${directory}/text.sock`;
    serve({ unix }, () => new Response("Forbidden", { status: 403 }));
    expect(
      await requestDocker({ endpoint: unix, path: "/x", timeoutMs: 1000 })
    ).toEqual({ body: undefined, status: 403 });
  });

  test("sends to an Engine API's URL under the URL's own path, one slash between", async () => {
    const server = serve({ hostname: "127.0.0.1", port: 0 }, () =>
      Response.json([])
    );
    for (const endpoint of [
      `http://127.0.0.1:${server.port}/docker`,
      `http://127.0.0.1:${server.port}/docker/`,
    ]) {
      seen.length = 0;
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: one endpoint at a time, so `seen` holds its request alone
        await requestDocker({
          endpoint,
          path: "/containers/json?all=true",
          timeoutMs: 1000,
        })
      ).toEqual({ body: [], status: 200 });
      expect(seen).toEqual([
        { method: "GET", path: "/docker/containers/json?all=true" },
      ]);
    }
  });

  test("rejects with ENOENT, naming the path, when no socket is there", async () => {
    const unix = `${directory}/nothing.sock`;
    const error = await failure(
      requestDocker({ endpoint: unix, path: "/x", timeoutMs: 1000 })
    );
    expect(error.code).toBe("ENOENT");
    expect(error.message).toContain(unix);
  });

  test("rejects with EACCES when the socket is not this process's to open", async () => {
    const unix = `${directory}/denied.sock`;
    serve({ unix }, () => Response.json([]));
    await Bun.$`chmod 000 ${unix}`;
    const error = await failure(
      requestDocker({ endpoint: unix, path: "/x", timeoutMs: 1000 })
    );
    expect(error.code).toBe("EACCES");
    expect(error.message).toContain(unix);
  });

  test("rejects with ECONNREFUSED when the path is no listening socket", async () => {
    const unix = `${directory}/plain-file`;
    await Bun.write(unix, "not a socket");
    const error = await failure(
      requestDocker({ endpoint: unix, path: "/x", timeoutMs: 1000 })
    );
    expect(error.code).toBe("ECONNREFUSED");
  });

  test("rejects with a TimeoutError when the daemon never answers", async () => {
    const unix = `${directory}/silent.sock`;
    serve({ unix }, () => new Promise<Response>(() => undefined));
    const started = Date.now();
    const error = await failure(
      requestDocker({ endpoint: unix, path: "/x", timeoutMs: 50 })
    );
    expect(error.name).toBe("TimeoutError");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("rejects an answer past the cap rather than holding it in memory", async () => {
    const unix = `${directory}/large.sock`;
    serve({ unix }, () => new Response("x".repeat(dockerAnswerMaxBytes + 1)));
    const error = await failure(
      requestDocker({ endpoint: unix, path: "/x", timeoutMs: 2000 })
    );
    expect(error.message).toBe(
      "the Docker endpoint's answer is larger than 4 MB"
    );
  });
});
