/**
 * The Docker check and the form's container list over a fake Docker Engine
 * API, served by Bun.serve on a Unix socket in a temp directory and over
 * TCP, through the live adapter: no daemon is needed. The answers are the
 * shapes Docker 29.8.2 (API 1.56) gave for real containers in each state,
 * cut to the fields that matter and a few beside them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type { DockerConfig } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  type DockerAnswer,
  type DockerIo,
  listContainers,
  runDockerCheck,
} from "./docker.ts";
import { requestDocker } from "./docker-io.ts";

const at = "2026-10-05T20:45:24.297253952Z";
const never = "0001-01-01T00:00:00Z";

/** `State` as Docker answers it for a container in the state named. */
function state(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    Dead: false,
    Error: "",
    ExitCode: 0,
    FinishedAt: never,
    OOMKilled: false,
    Paused: false,
    Pid: 590_210,
    Restarting: false,
    Running: true,
    StartedAt: at,
    Status: "running",
    ...patch,
  };
}

function health(status: string, output = "") {
  return {
    FailingStreak: status === "unhealthy" ? 6 : 0,
    Log: [
      {
        End: "2026-10-05T23:45:29.501946837+03:00",
        ExitCode: status === "unhealthy" ? 1 : 0,
        Output: output,
        Start: "2026-10-05T23:45:29.482399442+03:00",
      },
    ],
    Status: status,
  };
}

/** Each container the fake daemon knows, by name, with its `State`. */
const states: Record<string, Record<string, unknown>> = {
  created: state({
    Pid: 0,
    Running: false,
    StartedAt: never,
    Status: "created",
  }),
  dead: state({ Dead: true, Pid: 0, Running: false, Status: "dead" }),
  exited: state({ ExitCode: 3, Pid: 0, Running: false, Status: "exited" }),
  failed: state({
    Error: "driver failed programming external connectivity",
    ExitCode: 128,
    Pid: 0,
    Running: false,
    Status: "created",
  }),
  healthy: state({ Health: health("healthy") }),
  none: state({ Health: health("none") }),
  paused: state({ Paused: true, Status: "paused" }),
  removing: state({ Pid: 0, Running: false, Status: "removing" }),
  restarting: state({
    ExitCode: 1,
    Pid: 0,
    Restarting: true,
    Status: "restarting",
  }),
  running: state({}),
  starting: state({ Health: health("starting") }),
  unhealthy: state({
    Health: health("unhealthy", "curl: (7) Failed to connect to localhost\n"),
  }),
};

/** One container of `GET /containers/json`, as Docker lists it. */
function listed(name: string, image: string, status: string) {
  return {
    Command: "sleep 3600",
    Created: 1_791_233_125,
    HostConfig: { NetworkMode: "bridge" },
    Id: `${name.length}0e10796c2269cebefe57180b93bbfee084e33909eba4772bb7d6fa0af8bc58`,
    Image: image,
    Labels: {},
    Mounts: [],
    Names: [`/${name}`],
    Ports: [],
    State: status,
    Status: status === "running" ? "Up 12 seconds" : "Exited (3) 7 seconds ago",
  };
}

const list = [
  listed("worker", "registry.example.test/worker:2", "exited"),
  listed("api", "nginx:1.30.5-alpine", "running"),
  {
    ...listed("db", "postgres:18.6-alpine", "running"),
    Names: ["/web/db", "/db"],
  },
];

/** What the fake daemon was asked, path and query. */
const asked: string[] = [];
let listAnswer: () => Response = () => Response.json(list);

const mountPath = /^\/docker/;
const inspectPath = /^\/containers\/([^/]+)\/json$/;

/** The fake Engine API: inspect by name, the list, and the answers a broken daemon or a proxy gives. */
function daemon(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  asked.push(`${url.pathname}${url.search}`);
  const path = url.pathname.replace(mountPath, "");
  if (path === "/containers/json") {
    return listAnswer();
  }
  const name = inspectPath.exec(path)?.[1] ?? "";
  const known = states[name];
  if (known) {
    return Response.json({ Id: "c0ffee", Name: `/${name}`, State: known });
  }
  switch (name) {
    case "silent":
      return new Promise<Response>(() => undefined);
    case "broken":
      return Response.json(
        { message: "error while reading the container's state" },
        { status: 500 }
      );
    case "proxied":
      return new Response("Forbidden", { status: 403 });
    case "moved":
      return Response.redirect("http://elsewhere.example/", 301);
    case "quiet":
      return Response.json({
        Name: "/quiet",
        State: state({
          Health: { FailingStreak: 3, Log: null, Status: "unhealthy" },
        }),
      });
    // Podman's own API names a container without Docker's leading slash.
    case "podman":
      return Response.json({ Name: "podman", State: states.running });
    // A proxy at the wrong path, or any server that is no daemon, answers 404 for its own reasons.
    case "elsewhere":
      return new Response("404 page not found", { status: 404 });
    case "nowhere":
      return Response.json({ message: "page not found" }, { status: 404 });
    // Podman's compatible API words a missing container its own way.
    case "podgone":
      return Response.json(
        {
          cause: "no such container",
          message:
            'no container with name or ID "podgone" found: no such container',
          response: 404,
        },
        { status: 404 }
      );
    case "html":
      return new Response("<html>not docker</html>");
    // Docker matches an id prefix when no container has the name: "db5" names no container, so it answers another's.
    case "db5":
      return Response.json({ Name: "/other", State: states.running });
    default:
      return Response.json(
        { message: `No such container: ${name}` },
        { status: 404 }
      );
  }
}

let directory = "";
let socket = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let tcp: ReturnType<typeof Bun.serve> | undefined;
let origin = "";

beforeAll(async () => {
  directory = (await Bun.$`mktemp -d`.text()).trim();
  socket = `${directory}/docker.sock`;
  server = Bun.serve({ fetch: daemon, unix: socket });
  tcp = Bun.serve({ fetch: daemon, hostname: "127.0.0.1", port: 0 });
  origin = `http://127.0.0.1:${tcp.port}`;
});

afterAll(async () => {
  await server?.stop(true);
  await tcp?.stop(true);
  await Bun.$`rm -rf ${directory}`.quiet();
});

const live: DockerIo = {
  now: Date.now,
  requestDocker,
  sleep: () => Promise.resolve(),
};

function check(
  container: string,
  patch: Partial<DockerConfig> & {
    degradedMs?: number;
    timeoutMs?: number;
  } = {}
): Promise<CheckOutcome> {
  const { degradedMs, timeoutMs = 2000, ...config } = patch;
  return runDockerCheck(
    {
      config: { container, endpoint: socket, type: "docker", ...config },
      degradedMs,
      id: "m1",
      retries: 0,
      timeoutMs,
    },
    live
  );
}

describe("a Docker check over the daemon's Unix socket", () => {
  test("is up while the container runs with no health check", async () => {
    const { check: row, detail } = await check("running");
    expect(row.result).toBe("up");
    expect(row.reason).toBe(reasons.ok);
    expect(detail).toBe(undefined);
  });

  test("is up while its health check says healthy, none, or has not given a first verdict", async () => {
    for (const name of ["healthy", "none", "starting"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one state at a time
      expect((await check(name)).check.result).toBe("up");
    }
  });

  test("asks for the container by name on the daemon's own API version, with no version prefix", async () => {
    asked.length = 0;
    await check("running");
    expect(asked).toEqual(["/containers/running/json"]);
  });

  test("is down as unhealthy when the health check says so, with its last output as the raw error", async () => {
    const { check: row, detail } = await check("unhealthy");
    expect(row.result).toBe("down");
    expect(row.reason).toBe(reasons.container_unhealthy);
    expect(detail?.params).toEqual({ reason: "container_unhealthy" });
    expect(detail?.error).toBe("curl: (7) Failed to connect to localhost");
  });

  test("is down as not running when the container exited, with its state and exit code", async () => {
    const { check: row, detail } = await check("exited");
    expect(row.result).toBe("down");
    expect(row.reason).toBe(reasons.container_not_running);
    expect(detail?.params).toEqual({
      exitCode: 3,
      reason: "container_not_running",
      state: "exited",
    });
    expect(detail?.error).toBe(undefined);
  });

  test("is down as not running when the container was created and never started, or is being removed", async () => {
    for (const name of ["created", "removing"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one state at a time
      const { check: row, detail } = await check(name);
      expect(row.reason).toBe(reasons.container_not_running);
      expect(detail?.params).toEqual({
        exitCode: 0,
        reason: "container_not_running",
        state: name,
      });
    }
  });

  test("keeps Docker's error when a start failed as the raw error", async () => {
    const { detail } = await check("failed");
    expect(detail?.params).toEqual({
      exitCode: 128,
      reason: "container_not_running",
      state: "created",
    });
    expect(detail?.error).toBe(
      "driver failed programming external connectivity"
    );
  });

  test("is down as restarting while Docker restarts the container, with the exit code of the run that ended", async () => {
    const { check: row, detail } = await check("restarting");
    expect(row.reason).toBe(reasons.container_restarting);
    expect(detail?.params).toEqual({
      exitCode: 1,
      reason: "container_restarting",
    });
  });

  test("is down as paused while the container is paused, though Docker calls it running", async () => {
    const { check: row } = await check("paused");
    expect(row.result).toBe("down");
    expect(row.reason).toBe(reasons.container_paused);
  });

  test("is down as dead when Docker could not stop or remove the container", async () => {
    expect((await check("dead")).check.reason).toBe(reasons.container_dead);
  });

  test("is down as not found when the daemon knows no container by the name, with its message as the raw error", async () => {
    const { check: row, detail } = await check("gone");
    expect(row.result).toBe("down");
    expect(row.reason).toBe(reasons.container_not_found);
    expect(detail?.params).toEqual({ reason: "container_not_found" });
    expect(detail?.error).toBe("No such container: gone");
  });

  test("is down as not found when the daemon answers for another container, as an id prefix matches when no name does", async () => {
    const { check: row, detail } = await check("db5");
    expect(row.reason).toBe(reasons.container_not_found);
    // Named as the comparison reads it, with no leading slash.
    expect(detail?.error).toBe(
      "no container is named db5; the daemon answered for other"
    );
  });

  test("is down as not found when Podman says no such container in its own words", async () => {
    expect((await check("podgone")).check.reason).toBe(
      reasons.container_not_found
    );
  });

  test("is down with the status, never as not found, when a 404 is not the daemon's no such container", async () => {
    for (const name of ["elsewhere", "nowhere"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one answer at a time
      const { check: row, detail } = await check(name);
      expect(row.reason).toBe(reasons.unexpected_status);
      expect(detail?.params).toEqual({
        expected: ["200"],
        observed: 404,
        reason: "unexpected_status",
      });
    }
  });

  test("is down with the daemon's status when it answers an error, its message as the raw error", async () => {
    const { check: row, detail } = await check("broken");
    expect(row.reason).toBe(reasons.unexpected_status);
    expect(detail?.params).toEqual({
      expected: ["200"],
      observed: 500,
      reason: "unexpected_status",
    });
    expect(detail?.error).toBe("error while reading the container's state");
    // A status code is an HTTP monitor's alone.
    expect(row.statusCode).toBe(undefined);
  });

  test("is down with the status a socket proxy refuses with", async () => {
    const { detail } = await check("proxied");
    expect(detail?.params).toEqual({
      expected: ["200"],
      observed: 403,
      reason: "unexpected_status",
    });
  });

  test("is down as unknown when the endpoint answers something that is no container", async () => {
    const { check: row, detail } = await check("html");
    expect(row.reason).toBe(reasons.unknown);
    expect(detail?.error).toBeString();
  });

  test("is down as a timeout when the daemon never answers", async () => {
    const { check: row, detail } = await check("silent", { timeoutMs: 50 });
    expect(row.reason).toBe(reasons.timeout);
    expect(detail?.params).toEqual({ reason: "timeout", timeoutMs: 50 });
  });

  test("measures the API call as the response time, and is degraded over the threshold", async () => {
    const { check: row } = await check("running", { degradedMs: 1 });
    expect(row.responseMs).toBeGreaterThanOrEqual(0);
    const slow: DockerIo = {
      now: (() => {
        let t = 0;
        return () => {
          t += 50;
          return t;
        };
      })(),
      requestDocker: () =>
        Promise.resolve({
          body: { Name: "/web", State: states.running },
          status: 200,
        }),
      sleep: () => Promise.resolve(),
    };
    const outcome = await runDockerCheck(
      {
        config: { container: "web", endpoint: socket, type: "docker" },
        degradedMs: 10,
        id: "m1",
        retries: 0,
        timeoutMs: 2000,
      },
      slow
    );
    expect(outcome.check.result).toBe("degraded");
    expect(outcome.check.responseMs).toBe(50);
  });

  test("tries again on a down container until the retries are spent", async () => {
    const answers: DockerAnswer[] = [
      { body: { Name: "/web", State: states.restarting }, status: 200 },
      { body: { Name: "/web", State: states.running }, status: 200 },
    ];
    const outcome = await runDockerCheck(
      {
        config: { container: "web", endpoint: socket, type: "docker" },
        degradedMs: undefined,
        id: "m1",
        retries: 1,
        timeoutMs: 2000,
      },
      {
        now: Date.now,
        requestDocker: () =>
          Promise.resolve(answers.shift() ?? { body: undefined, status: 500 }),
        sleep: () => Promise.resolve(),
      }
    );
    expect(outcome.check.result).toBe("up");
    expect(outcome.check.attempts).toBe(2);
  });
});

describe("a Docker check's edges", () => {
  test("never follows a redirect away from the daemon: it reads as the status it is", async () => {
    const { detail } = await check("moved");
    expect(detail?.params).toEqual({
      expected: ["200"],
      observed: 301,
      reason: "unexpected_status",
    });
  });

  test("is unhealthy with no raw error when the health check kept no log", async () => {
    const { check: row, detail } = await check("quiet");
    expect(row.reason).toBe(reasons.container_unhealthy);
    expect(detail?.params).toEqual({ reason: "container_unhealthy" });
    expect(detail?.error).toBe(undefined);
  });

  test("takes a name answered without Docker's leading slash as the same container", async () => {
    expect((await check("podman")).check.result).toBe("up");
  });
});

describe("a Docker check over an Engine API's URL", () => {
  test("asks under the URL's own path, as a proxy mounted on one serves it", async () => {
    asked.length = 0;
    const { check: row } = await check("exited", {
      endpoint: `${origin}/docker/`,
    });
    expect(asked).toEqual(["/docker/containers/exited/json"]);
    expect(row.reason).toBe(reasons.container_not_running);
  });

  test("is down as connection refused with the URL's host and port when nothing listens", async () => {
    const held = Bun.serve({ fetch: () => new Response(), port: 0 });
    const port = held.port ?? 0;
    await held.stop(true);
    const { detail } = await check("running", {
      endpoint: `http://127.0.0.1:${port}`,
    });
    expect(detail?.params).toEqual({
      host: "127.0.0.1",
      port,
      reason: "connection_refused",
    });
  });
});

describe("the form's container list", () => {
  test("names every container, stopped ones too, sorted by name, each with its state and image", async () => {
    asked.length = 0;
    const result = await listContainers(socket, requestDocker, 2000);
    expect(asked).toEqual(["/containers/json?all=true"]);
    expect(result).toEqual({
      containers: [
        { image: "nginx:1.30.5-alpine", name: "api", state: "running" },
        { image: "postgres:18.6-alpine", name: "db", state: "running" },
        {
          image: "registry.example.test/worker:2",
          name: "worker",
          state: "exited",
        },
      ],
      ok: true,
    });
  });

  test("reads the same list through an Engine API's URL", async () => {
    const result = await listContainers(origin, requestDocker, 2000);
    expect(result.ok && result.containers.length).toBe(3);
  });

  test("is empty when the daemon has no containers", async () => {
    listAnswer = () => Response.json([]);
    try {
      expect(await listContainers(socket, requestDocker, 2000)).toEqual({
        containers: [],
        ok: true,
      });
    } finally {
      listAnswer = () => Response.json(list);
    }
  });

  test("answers the reason a check would give when the proxy refuses the list", async () => {
    listAnswer = () => new Response("Forbidden", { status: 403 });
    try {
      expect(await listContainers(socket, requestDocker, 2000)).toEqual({
        error: undefined,
        ok: false,
        params: {
          expected: ["200"],
          observed: 403,
          reason: "unexpected_status",
        },
        reason: "unexpected_status",
      });
    } finally {
      listAnswer = () => Response.json(list);
    }
  });

  test("answers unknown when the endpoint answers something that is no list", async () => {
    listAnswer = () => Response.json({ message: "page not found" });
    try {
      const result = await listContainers(socket, requestDocker, 2000);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe("unknown");
    } finally {
      listAnswer = () => Response.json(list);
    }
  });

  test("answers connection failed when no socket is at the path, never throws", async () => {
    const result = await listContainers(
      `${directory}/missing.sock`,
      requestDocker,
      2000
    );
    expect(result).toMatchObject({
      ok: false,
      params: { code: "ENOENT", reason: "connection_failed" },
      reason: "connection_failed",
    });
  });
});
