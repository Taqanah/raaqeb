import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { connect } from "node:http2";
import { authFor, operatorName } from "./server/auth/auth.ts";
import { resetPasswordCommand, type Terminal } from "./server/auth/command.ts";
import {
  invitationTokenHash,
  newInvitationToken,
} from "./server/auth/invitation.ts";
import { knownBrowsersOf } from "./server/auth/known-browsers.ts";
import { authEmailChannel, authEmailChannelOf } from "./server/auth/mail.ts";
import { generateInstallKey } from "./server/boot/installkey.ts";
import { resolveBootSettings } from "./server/boot/settings.ts";
import { heartbeatBodyReadBytes } from "./server/monitors/heartbeat.ts";
import { createChannel, deleteChannel } from "./server/notify/channels.ts";
import { createOperatorAccount } from "./server/onboarding/onboarding.ts";
import { publish } from "./server/pages/fixture.ts";
import { createPage, savePage } from "./server/pages/pages.ts";
import { currentVersion } from "./server/release/release.ts";
import { publicAddress } from "./server/settings/address.ts";
import { saveGeneralSettings } from "./server/settings/general.ts";
import { trustedProxies } from "./server/settings/proxies.ts";
import { requestLogEnabled } from "./server/settings/request-log.ts";
import { channelsRepository } from "./server/storage/channels.ts";
import { closeConnection, executor } from "./server/storage/connection.ts";
import { connectTo, runSql } from "./server/storage/fixture.ts";
import { runMigrator } from "./server/storage/migrate.ts";
import {
  localMigrations,
  migrationsFolder,
} from "./server/storage/migrationfiles.ts";
import { settingsRepository } from "./server/storage/settings.ts";
import {
  databaseOpener,
  locateDatabase,
  openStorage,
  type Storage,
} from "./server/storage/storage.ts";
import {
  accountSaves,
  type BodyGroup,
  cacheControl,
  eventLine,
  loadServerEntry,
  main,
  maintenanceLine,
  preloadAssets,
  type RenderLane,
  type StrangerPace,
  stopSignals,
  strangerPace,
} from "./server.ts";
import { monitorEventKinds } from "./shared/schemas/monitor.ts";
import { statusPageHeader } from "./shared/schemas/page.ts";
import { reasons } from "./shared/schemas/reason.ts";

/** A new heartbeat monitor's token, which the entry admits a report carrying a body by. */
async function heartbeatToken(storage: Storage | undefined): Promise<string> {
  const { id } =
    (await storage?.monitors.create({
      channels: [],
      config: {
        schedule: { everyMs: 300_000, kind: "every" },
        type: "heartbeat",
      },
      events: [...monitorEventKinds],
      intervalMs: 60_000,
      name: "Backup",
      retries: 2,
      tags: [],
      timeoutMs: 10_000,
    })) ?? {};
  const token = id && (await storage?.monitors.heartbeatTokenOf(id));
  if (!token) {
    throw new Error("expected a heartbeat monitor");
  }
  return token;
}

// The subscribe server function's address, as the build names it.
const subscribePath = "/_serverFn/routes.-subscriptions--subscribeFn";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => Bun.$`rm -rf ${dir}`.quiet()));
});

/** A server build holding these files and every migration, as `vite build` writes it. */
async function serverBuild(files: Record<string, string>): Promise<string> {
  const dir = await clientBuild(files);
  await carryMigrations(dir, Number.POSITIVE_INFINITY);
  return dir;
}

async function clientBuild(files: Record<string, string>): Promise<string> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  tempDirs.push(dir);
  await Promise.all(
    Object.entries(files).map(([path, content]) =>
      Bun.write(`${dir}/${path}`, content)
    )
  );
  return dir;
}

describe("client asset cache policy", () => {
  test("a hashed asset under /assets is immutable for a year", () => {
    expect(cacheControl("/assets/app-Bx1c9d2e.js")).toBe(
      "public, max-age=31536000, immutable"
    );
  });

  test("an unhashed file revalidates on every request", () => {
    expect(cacheControl("/favicon.svg")).toBe("no-cache");
  });
});

describe("client asset preload", () => {
  test("every file of the client build becomes a route keyed by URL path", async () => {
    const dir = await clientBuild({
      "assets/app-Bx1c9d2e.js": "console.log(1);",
      "favicon.svg": "<svg/>",
      "fonts/rubik.woff2": "font",
    });
    const routes = await preloadAssets(dir);
    expect(Object.keys(routes).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "/assets/app-Bx1c9d2e.js",
      "/favicon.svg",
      "/fonts/rubik.woff2",
    ]);
  });

  test("a route answers the file's bytes with its type and cache policy", async () => {
    const dir = await clientBuild({
      "assets/app-Bx1c9d2e.js": "console.log(1);",
    });
    const routes = await preloadAssets(dir);
    const response = routes["/assets/app-Bx1c9d2e.js"];
    expect(response).toBeDefined();
    expect(await response?.text()).toBe("console.log(1);");
    expect(response?.headers.get("content-type")).toStartWith(
      "text/javascript"
    );
    expect(response?.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
  });

  test("the files every browser and crawler asks for unprompted are served, not answered with the not-found page", async () => {
    // The Vite build copies `public/` into the client build, so its files are the routes.
    const routes = await preloadAssets(`${import.meta.dir}/../public`);
    expect(routes["/favicon.ico"]?.headers.get("content-type")).toBe(
      "image/x-icon"
    );
    expect(await routes["/robots.txt"]?.text()).toStartWith("User-agent: *");
  });

  test("a missing client build directory yields no routes", async () => {
    const routes = await preloadAssets("/nonexistent/raaqeb-client-build");
    expect(routes).toEqual({});
  });
});

describe("loading the server build", () => {
  test("a missing build is reported, not thrown", async () => {
    expect(await loadServerEntry("/nonexistent/raaqeb/handler.js")).toBe(
      undefined
    );
  });

  test("a build exporting a fetch handler is the server entry", async () => {
    const dir = await clientBuild({
      "handler.js": "export default { fetch: () => new Response('ok') };",
    });
    const entry = await loadServerEntry(`${dir}/handler.js`);
    expect(entry).toBeDefined();
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dir });
    if (!booted.ok) {
      throw new Error(booted.message);
    }
    const response = await entry?.fetch(new Request("http://raaqeb.test/"), {
      context: {
        boot: booted.settings,
        holdOpen: () => undefined,
        nonce: "a-nonce",
        scheduler: undefined,
        opener: databaseOpener(() => undefined),
        publicTarget: undefined,
        storage: undefined,
      },
    });
    expect(await response?.text()).toBe("ok");
  });

  test("a build without a fetch handler is not a server entry", async () => {
    const dir = await clientBuild({ "handler.js": "export default {};" });
    expect(await loadServerEntry(`${dir}/handler.js`)).toBe(undefined);
  });
});

/** A build directory holding a client file and a server handler answering "ok". */
async function build(): Promise<string> {
  const dir = await bareBuild();
  await carryMigrations(dir, Number.POSITIVE_INFINITY);
  return dir;
}

/** The same build carrying no migrations. */
async function bareBuild(): Promise<string> {
  return await clientBuild({
    "client/assets/app-Bx1c9d2e.js": "console.log(1);",
    "server/handler.js":
      "export default { fetch: (r) => new Response('ok ' + new URL(r.url).pathname) };",
  });
}

/** Copies the first `count` migrations of each dialect into the build, where `vite build` puts them. */
async function carryMigrations(dir: string, count: number): Promise<void> {
  await Promise.all(
    (["sqlite", "postgres"] as const).map(async (backend) => {
      const names = (await localMigrations(backend)).slice(0, count);
      await Promise.all(
        names.map((name) =>
          Bun.write(
            `${dir}/migrations/${backend}/${name}/migration.sql`,
            Bun.file(`${migrationsFolder(backend)}/${name}/migration.sql`)
          )
        )
      );
    })
  );
}

/** One request over HTTP/2 with prior knowledge, as a proxy with an HTTP/2 backend sends it: its status and body. A body without `length` streams with no content-length. */
function overHttp2(
  origin: string,
  path: string,
  init: { body?: Uint8Array | string; length?: boolean; method?: string } = {}
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const session = connect(origin);
    session.on("error", reject);
    const headers: Record<string, string | number> = {
      ":method": init.method ?? "GET",
      ":path": path,
    };
    if (init.body !== undefined && init.length !== false) {
      headers["content-length"] = Buffer.byteLength(init.body);
    }
    const stream = session.request(headers);
    let status = 0;
    const chunks: Buffer[] = [];
    stream.on("response", (answer) => {
      status = Number(answer[":status"]);
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      session.close();
      resolve({ body: Buffer.concat(chunks).toString(), status });
    });
    stream.on("error", reject);
    stream.end(init.body);
  });
}

/** A render pace for a test: renders `gapMs` apart, room for 100 in every lane but those named, the checks unpaced unless given, 100 bodies in flight in each group unless given, rate rules no test meets unless given, the shipped body deadline and a table of 10,000 clients unless given. */
function testPace(
  gapMs: number,
  room: Partial<Record<RenderLane, number>>,
  checks: { readonly gapMs: number; readonly waiting: number } = {
    gapMs: 0,
    waiting: 100,
  },
  bodies: Partial<Record<BodyGroup, number>> = {},
  rates: Partial<StrangerPace["rates"]> = {},
  bodyDeadlineMs = strangerPace.bodyDeadlineMs,
  rateClients = 10_000
): StrangerPace {
  const lanes: RenderLane[] = [
    "cold",
    "onboarding",
    "others",
    "overview",
    "pages",
    "refresh",
    "reset",
    "subscriptions",
  ];
  const plenty = { capacity: 10_000, everyMs: 1 };
  return {
    bodies: {
      forms: 100,
      heartbeats: 100,
      others: 100,
      signIn: 100,
      ...bodies,
    },
    bodyDeadlineMs,
    checks: {
      burst: 1,
      gapMs: checks.gapMs,
      overrun: 2,
      turnMs: 5000,
      waiting: { checks: checks.waiting },
    },
    rateClients,
    rates: {
      heartbeat: plenty,
      mail: plenty,
      others: plenty,
      pagePassword: plenty,
      password: plenty,
      resetMail: plenty,
      signIn: plenty,
      subscribe: plenty,
      ...rates,
    },
    renders: {
      burst: 1,
      gapMs,
      overrun: 2,
      turnMs: 5000,
      waiting: Object.fromEntries(
        lanes.map((lane) => [lane, room[lane] ?? 100])
      ) as Record<RenderLane, number>,
    },
  };
}

/** A process running `raaqeb serve` on the data directory, build and port its arguments name; it prints `port <n>` after its log lines, or exits with the command's code. */
const serveScript = `
  const { main } = await import("${import.meta.dir}/server.ts");
  const [dataDir, dir, port] = Bun.argv.slice(1);
  const result = await main(["--port", port, "--data-dir", dataDir], {}, dir);
  if (typeof result === "number") process.exit(result);
  console.log("port " + result.server.port);
  setInterval(() => {}, 1 << 30);
`;

const announcedPort = /^port (\d+)$/m;

/** The port a `serveScript` process announces, read as its output arrives. */
async function portOf(output: ReadableStream<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of output) {
    text += new TextDecoder().decode(chunk);
    const port = announcedPort.exec(text)?.[1];
    if (port) {
      return port;
    }
  }
  throw new Error(`the server never announced its port: ${text}`);
}

async function withServer(
  args: string[],
  env: Record<string, string>,
  dir: string,
  body: (
    server: Bun.Server<undefined>,
    storage: Storage | undefined
  ) => Promise<void>
): Promise<void> {
  const result = await main(args, env, dir);
  if (typeof result === "number") {
    throw new Error(`expected a server, got exit code ${result}`);
  }
  try {
    await body(result.server, result.storage);
  } finally {
    await result.stop();
  }
}

describe("a monitor event as a log line", () => {
  test("names the monitor and the event, and a down event its reason", () => {
    expect(
      eventLine({
        at: 1,
        kind: "down",
        monitorId: "m1",
        reason: reasons.timeout,
      })
    ).toBe("monitor m1 is down (timeout)");
    expect(
      eventLine({
        at: 1,
        kind: "down",
        locations: [
          { id: "main", name: undefined },
          { id: "p1", name: "Frankfurt" },
        ],
        monitorId: "m1",
        reason: reasons.timeout,
      })
    ).toBe("monitor m1 is down (timeout) from main, probe p1");
    expect(
      eventLine({
        at: 1,
        kind: "recovered",
        monitorId: "m1",
        reason: reasons.ok,
      })
    ).toBe("monitor m1 recovered");
    expect(
      eventLine({
        at: 1,
        kind: "degraded_started",
        monitorId: "m1",
        reason: reasons.ok,
      })
    ).toBe("monitor m1 is degraded");
    expect(
      eventLine({
        at: 1,
        kind: "degraded_ended",
        monitorId: "m1",
        reason: reasons.ok,
      })
    ).toBe("monitor m1 is no longer degraded");
    expect(
      eventLine({
        at: 1,
        kind: "certificate_expiring",
        monitorId: "m1",
        validTo: Date.UTC(2026, 9, 8, 12),
        warning: "threshold",
      })
    ).toBe("monitor m1 has a certificate expiring at 2026-10-08T12:00:00.000Z");
  });

  test("an expiring domain registration names the domain and when it ends", () => {
    expect(
      eventLine({
        at: 1,
        domain: "raaqeb.dev",
        expiresAt: Date.UTC(2026, 10, 7),
        kind: "domain_expiring",
        monitorId: "m1",
      })
    ).toBe(
      "monitor m1 has a domain registration expiring: raaqeb.dev at 2026-11-07T00:00:00.000Z"
    );
  });
});

describe("a maintenance window's move as a log line", () => {
  test("names the window and what happened to it", () => {
    const window = {
      componentIds: ["c1"],
      createdAt: 1,
      endsAt: 3,
      id: "w1",
      message: { ar: "نص" },
      startsAt: 2,
      title: { ar: "صيانة" },
      updatedAt: 1,
    };
    expect(maintenanceLine({ ...window, stage: "in_progress" })).toBe(
      "maintenance window w1 started"
    );
    expect(maintenanceLine({ ...window, stage: "completed" })).toBe(
      "maintenance window w1 completed"
    );
  });
});

describe("the raaqeb command", () => {
  test("serve is the default and listens on the boot settings", async () => {
    const dataDir = await clientBuild({});
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      await build(),
      async (server) => {
        expect(server.hostname).toBe("127.0.0.1");
        expect(server.port).toBeGreaterThan(0);
        const response = await fetch(`http://127.0.0.1:${server.port}/sign-in`);
        expect(await response.text()).toBe("ok /sign-in");
      }
    );
  });

  test("serve opens the default SQLite file when it already exists", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir],
      {},
      await build()
    );
    if (typeof result === "number") {
      throw new Error(`expected a server, got exit code ${result}`);
    }
    try {
      expect(result.storage?.backend).toBe("sqlite");
      expect(await result.storage?.changeCounter()).toBe(0);
    } finally {
      await result.stop();
    }
  });

  test("every request carries the open storage as Start's request context", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: (r, o) => new Response(String(o?.context?.storage?.backend)) };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(await response.text()).toBe("sqlite");
      }
    );
  });

  test("a request body over 64 KiB with no live session, or one with no length, is refused before the handler; the key-guarded APIs and the heartbeat take 8 MB, and an import streams in whole", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.arrayBuffer()).byteLength) };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server, storage) => {
        const token = await heartbeatToken(storage);
        const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;
        const large = new Uint8Array(9 * 1024 * 1024);
        const post = (path: string, body: BodyInit) =>
          fetch(at(path), { body, method: "POST" });
        const chunked = () =>
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(new Uint8Array(10));
              controller.close();
            },
          });
        // A stranger reaches each of these with a body that is read in whole before any check of who sent it.
        const limit = new Uint8Array(65_536);
        const over = new Uint8Array(65_537);
        for (const path of [
          "/_serverFn/any",
          "/api/auth/sign-in/email",
          "/sign-in",
        ]) {
          // biome-ignore lint/performance/noAwaitInLoops: one request at a time, each judged alone
          expect(await (await post(path, limit)).text()).toBe(
            `read ${limit.length}`
          );
          const refused = await post(path, over);
          expect(refused.status).toBe(413);
          // Read and dropped, so a proxy still streaming it gets this answer.
          expect(refused.headers.get("connection")).not.toBe("close");
        }
        const keyed = new Uint8Array(8 * 1024 * 1024);
        // The heartbeat's route reads a kilobyte of it, and the entry reads that much under the deadline.
        for (const [path, read] of [
          ["/api/v1/monitors", keyed.length],
          ["/api/probe/v1/results", keyed.length],
          [`/api/heartbeat/${token}`, heartbeatBodyReadBytes],
        ] as const) {
          // biome-ignore lint/performance/noAwaitInLoops: one request at a time, each judged alone
          expect(await (await post(path, keyed)).text()).toBe(`read ${read}`);
          expect((await post(path, large)).status).toBe(413);
        }
        expect((await post("/sign-in", chunked())).status).toBe(413);
        expect(await (await post("/sign-in", "small")).text()).toBe("read 5");
        expect(await (await post("/admin/import", large)).text()).toBe(
          `read ${large.length}`
        );
        expect(await (await post("/admin/import", chunked())).text()).toBe(
          "read 10"
        );
        // Past Bun's own default of 128 MB, which would answer 413 itself.
        const export200 = new Uint8Array(200 * 1024 * 1024);
        expect(await (await post("/admin/import", export200)).text()).toBe(
          `read ${export200.length}`
        );
      }
    );
  });

  test("a refused body's connection is kept, Bun dropping the rest of the body, so the next request on it is answered, even sent in the same packet; one declared past 64 MiB, or past four refusals a second, closes its connection", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.arrayBuffer()).byteLength) };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        /** What the server writes back to `sent` on one connection, until it closes it or a second's quiet. */
        const exchange = (sent: string) =>
          new Promise<{ closed: boolean; text: string }>((resolve) => {
            let text = "";
            let quiet: Timer | undefined;
            const settle = (closed: boolean) => {
              clearTimeout(quiet);
              resolve({ closed, text });
            };
            Bun.connect({
              hostname: "127.0.0.1",
              port: server.port ?? 0,
              socket: {
                close: () => settle(true),
                data: (socket, chunk) => {
                  text += chunk.toString();
                  clearTimeout(quiet);
                  quiet = setTimeout(() => {
                    socket.end();
                    settle(false);
                  }, 1000);
                },
                open: (socket) => {
                  socket.write(sent);
                },
              },
            });
          });
        const post = (length: number, body: string) =>
          `POST /_serverFn/any HTTP/1.1\r\nhost: raaqeb.test\r\ncontent-length: ${length}\r\n\r\n${body}`;
        const followed = await exchange(
          `${post(65_537, "a".repeat(65_537))}${post(5, "small")}`
        );
        expect(followed.text).toContain("HTTP/1.1 413");
        expect(followed.text).toContain("read 5");
        const largest = await exchange(post(64 * 1024 * 1024, "a"));
        expect(largest.text).toContain("HTTP/1.1 413");
        expect(largest.text.toLowerCase()).not.toContain("connection: close");
        const unread = await exchange(post(64 * 1024 * 1024 + 1, "a"));
        expect(unread.text).toContain("HTTP/1.1 413");
        expect(unread.text.toLowerCase()).toContain("connection: close");
        expect(unread.closed).toBe(true);
        // Four refusals a second keep their connection; a fifth closes its own.
        const burst = await Promise.all(
          [1, 2, 3, 4, 5].map(() => exchange(post(65_537, "a")))
        );
        expect(
          burst.filter((each) =>
            each.text.toLowerCase().includes("connection: close")
          ).length
        ).toBe(1);
      }
    );
  });

  test("a live session's save carries a body up to 8 MiB, past the monitor form at its caps in the serializer's widest character; elsewhere, and with a forged session cookie, it carries no more than a stranger", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.arrayBuffer()).byteLength) };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir);
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const live = created.setCookies
        .map((each) => each.split(";")[0])
        .join("; ");
      const post = (path: string, body: BodyInit, cookie: string) =>
        fetch(`http://127.0.0.1:${result.server.port}${path}`, {
          body,
          headers: { cookie },
          method: "POST",
        });
      // The monitor edit form with every capped text full of U+2028, which seroval and JSON write as 7 bytes each.
      const form = new Uint8Array(2_553_815);
      const limit = new Uint8Array(8 * 1024 * 1024);
      const save = "/_serverFn/any";
      expect(await (await post(save, form, live)).text()).toBe(
        `read ${form.length}`
      );
      expect(await (await post(save, limit, live)).text()).toBe(
        `read ${limit.length}`
      );
      expect(
        (await post(save, new Uint8Array(limit.length + 1), live)).status
      ).toBe(413);
      expect(
        (
          await post(
            save,
            new Uint8Array(65_537),
            "raaqeb.session_token=forged"
          )
        ).status
      ).toBe(413);
      // Better Auth's addresses are no save: a session's large body there is a stranger's.
      expect(
        (await post("/api/auth/update-user", new Uint8Array(65_537), live))
          .status
      ).toBe(413);
    } finally {
      await result.stop();
    }
  });

  test("a heartbeat call whose body streams with no length reaches the route, whose own read stops at a kilobyte; a declared body over 8 MB is still refused there", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.arrayBuffer()).byteLength) };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server, storage) => {
        const token = await heartbeatToken(storage);
        const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;
        const chunked = () =>
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(new Uint8Array(10));
              controller.close();
            },
          });
        const post = (path: string, body: BodyInit) =>
          fetch(at(path), { body, method: "POST" });
        await Promise.all(
          [`/api/heartbeat/${token}`, `/api/heartbeat/${token}/fail`].map(
            async (path) => {
              expect(await (await post(path, chunked())).text()).toBe(
                "read 10"
              );
              expect(
                (await post(path, new Uint8Array(9 * 1024 * 1024))).status
              ).toBe(413);
            }
          )
        );
        expect((await post("/api/heartbeats", chunked())).status).toBe(413);
      }
    );
  });

  test("an import's upload streams through the entry without the server keeping what was read, so a backup larger than the floor's memory comes in", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js": `export default { fetch: async (r) => {
        let start;
        for await (const chunk of r.body) start ??= (Bun.gc(true), process.memoryUsage.rss());
        Bun.gc(true);
        return new Response(String(process.memoryUsage.rss() - start));
      } };`,
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        const megabyte = new Uint8Array(1024 * 1024);
        let sent = 0;
        const upload = new ReadableStream<Uint8Array>({
          pull: (controller) => {
            if (sent < 256) {
              sent += 1;
              controller.enqueue(megabyte);
            } else {
              controller.close();
            }
          },
        });
        const response = await fetch(
          `http://127.0.0.1:${server.port}/admin/import`,
          { body: upload, method: "POST" }
        );
        expect(response.status).toBe(200);
        // 256 MB went through; the floor's whole budget is 240 MB.
        expect(Number(await response.text())).toBeLessThan(64 * 1024 * 1024);
      }
    );
  });

  test("the same port speaks HTTP/2 to a client that opens with its preface, as a proxy with an HTTP/2 backend does, and HTTP/1.1 to any other", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: (r) => new Response('handled ' + new URL(r.url).pathname) };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const two = await overHttp2(origin, "/sign-out");
        expect(two.status).toBe(200);
        expect(two.body).toBe("handled /sign-out");
        expect(await (await fetch(`${origin}/sign-out`)).text()).toBe(
          "handled /sign-out"
        );
      }
    );
  });

  test("over HTTP/2 a body over the limit, or one with no length, is refused before the handler, as over HTTP/1.1; an import's streams in whole", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.arrayBuffer()).byteLength) };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const post = (path: string, body: Uint8Array | string, length = true) =>
          overHttp2(origin, path, { body, length, method: "POST" });
        const large = new Uint8Array(9 * 1024 * 1024);
        expect((await post("/sign-in", large)).status).toBe(413);
        expect((await post("/sign-in", "small", false)).status).toBe(413);
        expect((await post("/sign-in", "small")).body).toBe("read 5");
        expect((await post("/admin/import", "streamed", false)).body).toBe(
          "read 8"
        );
        expect((await post("/admin/import", large)).body).toBe(
          `read ${large.length}`
        );
      }
    );
  });

  test("a status page's view goes through the memo: a HEAD renders it as a GET, the next GET is the stored body and a held ETag a 304", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "let renders = 0; export default { fetch: (r, o) => { renders += 1; const t = o?.context?.publicTarget; return new Response(r.method === 'GET' ? 'render ' + renders + ' of ' + (t && t.pageId) : '', { headers: { 'cache-control': 'public, max-age=0, must-revalidate' } }); } };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir);
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const url = `http://127.0.0.1:${result.server.port}/`;
      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      const get = await fetch(url);
      expect(await get.text()).toBe(`render 1 of ${created.page.id}`);
      const held = await fetch(url, {
        headers: { "if-none-match": get.headers.get("etag") ?? "" },
      });
      expect(held.status).toBe(304);
      // Any other path renders as before, outside the memo.
      const other = await fetch(`http://127.0.0.1:${result.server.port}/admin`);
      expect(await other.text()).toBe("render 2 of undefined");
    } finally {
      await result.stop();
    }
  });

  /** A data directory whose database holds two email channels, or none left with `deleted: "both"`, migrated up to `count` migrations, with the sign-in mail choice a deleted channel, the newer one, or none stored. */
  async function withEmailChannels(
    count: number,
    chosen?: "deleted" | "newer",
    deleted?: "both"
  ): Promise<{ dataDir: string; newer: string; oldest: string }> {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const earlier = await clientBuild({});
    await carryMigrations(earlier, count);
    // The migrator alone: an earlier version's database rightly lacks later tables, which `openStorage` checks for.
    const connection = await connectTo({
      backend: "sqlite",
      file: `${dataDir}/raaqeb.sqlite`,
    });
    await runMigrator(connection, `${earlier}/migrations`);
    const run = executor(connection);
    const channels = channelsRepository(run, Date.now);
    const email = (name: string) =>
      channels.create({
        appliesToNew: false,
        config: { from: "raaqeb@example.test", host: "smtp.example.test" },
        locale: undefined,
        name,
        type: "email",
      });
    const oldest = await email("Oldest");
    const newer = await email("Newer");
    if (chosen !== undefined) {
      await settingsRepository(run, Date.now).set(
        authEmailChannel,
        chosen === "newer" ? newer.id : "a deleted channel"
      );
    }
    if (deleted === "both") {
      await channels.remove(oldest.id);
      await channels.remove(newer.id);
    }
    await closeConnection(connection);
    return { dataDir, newer: newer.id, oldest: oldest.id };
  }

  async function bootOver(dataDir: string) {
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: () => new Response('render') };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir);
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    return { ...result, storage: result.storage };
  }

  test("an install that never stored the sign-in mail choice boots with its oldest email channel as the choice; once an owner deletes it, a restart chooses none", async () => {
    const { dataDir, oldest } = await withEmailChannels(
      Number.POSITIVE_INFINITY
    );
    const first = await bootOver(dataDir);
    try {
      expect(await first.storage.settings.get(authEmailChannel)).toBe(oldest);
      expect(await deleteChannel(first.storage, oldest)).toEqual({ ok: true });
    } finally {
      await first.stop();
    }
    const second = await bootOver(dataDir);
    try {
      expect(await authEmailChannelOf(second.storage)).toBeUndefined();
    } finally {
      await second.stop();
    }
  });

  test("an install from before operator accounts boots with the channel its one operator chose, or the oldest email channel it fell back to when that one was deleted", async () => {
    const before = (await localMigrations("sqlite")).findIndex((name) =>
      name.endsWith("_operator_accounts")
    );
    const deleted = await withEmailChannels(before, "deleted");
    const fellBack = await bootOver(deleted.dataDir);
    try {
      expect((await authEmailChannelOf(fellBack.storage))?.id).toBe(
        deleted.oldest
      );
    } finally {
      await fellBack.stop();
    }
    const kept = await withEmailChannels(before, "newer");
    const chose = await bootOver(kept.dataDir);
    try {
      expect((await authEmailChannelOf(chose.storage))?.id).toBe(kept.newer);
    } finally {
      await chose.stop();
    }
  });

  test("an install from before operator accounts whose operator deleted every email channel boots with no choice, so the owner's next email channel carries sign-in mail", async () => {
    const before = (await localMigrations("sqlite")).findIndex((name) =>
      name.endsWith("_operator_accounts")
    );
    const { dataDir } = await withEmailChannels(before, "deleted", "both");
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await bootOver(dataDir);
    try {
      expect(
        await result.storage.settings.get(authEmailChannel)
      ).toBeUndefined();
      if (!booted.ok) {
        throw new Error(booted.message);
      }
      const created = await createChannel(
        result.storage,
        booted.settings.installKey,
        {
          appliesToNew: false,
          name: "Owner's mail",
          type: "email",
          values: {
            from: "raaqeb@example.test",
            host: "127.0.0.1",
            port: "2525",
            security: "none",
            to: "team@example.test",
          },
        }
      );
      expect((await authEmailChannelOf(result.storage))?.id).toBe(
        created.ok ? created.channel.id : "not created"
      );
    } finally {
      await result.stop();
    }
  });

  test("a command that opens an install from before operator accounts first keeps the email channel it fell back to, as the boot would", async () => {
    const before = (await localMigrations("sqlite")).findIndex((name) =>
      name.endsWith("_operator_accounts")
    );
    const { dataDir, oldest } = await withEmailChannels(before, "deleted");
    const terminal: Terminal = {
      askHidden: () => Promise.resolve(""),
      err: () => undefined,
      interactive: false,
      out: () => undefined,
    };
    expect(
      await main(
        ["set-address", "https://status.example.test", "--data-dir", dataDir],
        { RAAQEB_SECRET_KEY: generateInstallKey() },
        await serverBuild({}),
        { terminal }
      )
    ).toBe(0);
    const result = await bootOver(dataDir);
    try {
      expect((await authEmailChannelOf(result.storage))?.id).toBe(oldest);
    } finally {
      await result.stop();
    }
  });

  test("onboarding's screens once the account exists, and a subscription's page no subscription has, are the plain not-found rendered once; before the account onboarding is the app's", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "let renders = 0; export default { fetch: (r) => { renders += 1; return new Response('render ' + renders + ' of ' + new URL(r.url).pathname, { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 404 }); } };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir);
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const at = async (path: string) =>
        await (
          await fetch(`http://127.0.0.1:${result.server.port}${path}`)
        ).text();
      expect(await at("/onboarding")).toBe("render 1 of /onboarding");
      expect(await at("/onboarding")).toBe("render 2 of /onboarding");
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      expect(created.ok).toBe(true);
      expect(await at("/onboarding/account")).toBe(
        "render 3 of /onboarding/account"
      );
      for (const path of [
        "/onboarding",
        "/onboarding/database",
        "/subscriptions/AAAAAAAAAAAAAAAAAAAAAA",
        "/subscriptions/nope",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: one request at a time
        expect(await at(path), path).toBe("render 3 of /onboarding/account");
      }
    } finally {
      await result.stop();
    }
  });

  test("a burst of sign-in page loads costs one render, through a new host each or with a stale session cookie; another search renders", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "let renders = 0; export default { fetch: (r) => { renders += 1; return new Response('render ' + renders, { headers: { 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      async (server) => {
        const at = async (path: string, headers: Record<string, string> = {}) =>
          await (
            await fetch(`http://127.0.0.1:${server.port}${path}`, { headers })
          ).text();
        for (let i = 0; i < 100; i += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: one request at a time, as a burst sends them
          const page = await at("/sign-in", {
            "x-forwarded-host": `host-${i}.example`,
            "x-forwarded-proto": "https",
          });
          expect(page).toBe("render 1");
        }
        expect(
          await at("/sign-in", { cookie: "raaqeb.session_token=forged" })
        ).toBe("render 1");
        expect(await at("/sign-in?x=1")).toBe("render 2");
      }
    );
  });

  test("a stranger's misses of the status page memo take turns in the visitors' lane, and 200 asking one address at once cost one render", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "let renders = 0; export default { fetch: async (r) => { renders += 1; const n = renders; await Bun.sleep(50); return new Response('render ' + n, { headers: { 'cache-control': 'public, max-age=0, must-revalidate', 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(200, { cold: 1, refresh: 1 }),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const at = (path: string) =>
        fetch(`http://127.0.0.1:${result.server.port}${path}`);
      const distinct = await Promise.all(
        ["/", "/en", "/badge.svg", "/.env"].map((path) => at(path))
      );
      expect(
        distinct.map((each) => each.status).toSorted((a, b) => a - b)
      ).toEqual([200, 200, 503, 503]);
      await result.storage.bump();
      await Bun.sleep(250);
      const crowd = await Promise.all(
        Array.from({ length: 200 }, () => at("/"))
      );
      expect(new Set(crowd.map((each) => each.status))).toEqual(new Set([200]));
      const bodies = await Promise.all(crowd.map((each) => each.text()));
      expect(new Set(bodies).size).toBe(1);
    } finally {
      await result.stop();
    }
  });

  test("a stranger's burst on a private page costs one render of its access page and none of the page; the right password posted at its address earns a pass that opens it, never framed", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "let renders = 0; export default { fetch: async (r, o) => { renders += 1; const t = o?.context?.publicTarget; if (t && t.locked) { return new Response('<html><body><main data-slot=\"access-page\">locked ' + renders + '</main><p data-slot=\"access-wrong\" hidden>wrong</p></body></html>', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }); } return new Response('<html><body>secret render ' + renders + '</body></html>', { headers: { 'cache-control': 'public, max-age=0, must-revalidate', 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(200, {}),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const stored = await result.storage.pages.find(created.page.id);
      if (!stored) {
        throw new Error("no page");
      }
      const saved = await savePage(result.storage, created.page.id, {
        ...stored,
        access: { addresses: [], mode: "password", password: "correct horse" },
        layout: [],
      });
      if (!saved.ok) {
        throw new Error(saved.reason);
      }
      const origin = `http://127.0.0.1:${result.server.port}`;
      const crowd = await Promise.all(
        Array.from({ length: 300 }, (_, index) =>
          fetch(`${origin}${index % 2 ? "/" : "/history"}`)
        )
      );
      expect(new Set(crowd.map((each) => each.status))).toEqual(new Set([403]));
      const bodies = new Set(
        await Promise.all(crowd.map((each) => each.text()))
      );
      expect([...bodies].some((body) => body.includes("secret"))).toBe(false);
      expect([...bodies].every((body) => body.includes("locked 1"))).toBe(true);
      expect(crowd[0]?.headers.get("x-frame-options")).toBe("DENY");
      const wrong = await fetch(origin, {
        body: "password=nope",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        method: "POST",
        redirect: "manual",
      });
      expect(wrong.status).toBe(403);
      expect(await wrong.text()).toContain('<p data-slot="access-wrong">');
      const right = await fetch(origin, {
        body: "password=correct+horse",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        method: "POST",
        redirect: "manual",
      });
      expect(right.status).toBe(303);
      const cookie = right.headers.get("set-cookie")?.split(";")[0] ?? "";
      const opened = await fetch(origin, { headers: { cookie } });
      expect(opened.status).toBe(200);
      expect(await opened.text()).toContain("secret render");
      expect(opened.headers.get("x-frame-options")).toBe("DENY");
      // The kept view goes to no one else.
      const after = await fetch(origin);
      expect(after.status).toBe(403);
      expect(await after.text()).not.toContain("secret");
    } finally {
      await result.stop();
    }
  });

  test("a stranger's view the memo kept and that went stale renders in the refresh lane, apart from addresses it holds nothing for", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async () => { await Bun.sleep(100); return new Response('page', { headers: { 'cache-control': 'public, max-age=0, must-revalidate', 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(0, { cold: 1 }),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const at = (path: string) =>
        fetch(`http://127.0.0.1:${result.server.port}${path}`);
      const kept = ["/", "/en", "/history", "/en/history"];
      for (const path of kept) {
        // biome-ignore lint/performance/noAwaitInLoops: one at a time, so each cold render has the lane to itself
        expect((await at(path)).status, path).toBe(200);
      }
      await result.storage.bump();
      const [stale, cold] = await Promise.all([
        Promise.all(kept.map((path) => at(path))),
        Promise.all(
          ["/status/main", "/en/status/main"].map((path) => at(path))
        ),
      ]);
      expect(stale.map((each) => each.status)).toEqual([200, 200, 200, 200]);
      expect(cold.map((each) => each.status).toSorted((a, b) => a - b)).toEqual(
        [200, 503]
      );
    } finally {
      await result.stop();
    }
  });

  test("a stale overview refreshes in a lane of its own, so a flood of the page's other stale views leaves it a turn", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "let renders = 0; export default { fetch: async () => { renders += 1; await Bun.sleep(100); return new Response('render ' + renders, { headers: { 'cache-control': 'public, max-age=0, must-revalidate', 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(400, { refresh: 0 }),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const at = async (path: string) =>
        await (
          await fetch(`http://127.0.0.1:${result.server.port}${path}`)
        ).text();
      const others = [
        "/history",
        "/en/history",
        "/status/main/history",
        "/en/status/main/history",
        "/status/main/incidents/none",
        "/en/status/main/incidents/none",
      ];
      const before = await at("/");
      for (const path of others) {
        // biome-ignore lint/performance/noAwaitInLoops: one at a time, each its own render a gap apart
        await at(path);
      }
      await result.storage.bump();
      // The others' refreshes fill their lane: one renders, one waits, one has no room.
      // The others' refreshes fill their lane; the overview's waits a turn of the lanes, not their queue.
      await Promise.all(others.map((path) => at(path)));
      expect(await at("/")).toBe(before);
      await Bun.sleep(500);
      expect(await at("/")).not.toBe(before);
    } finally {
      await result.stop();
    }
  });

  test("a stranger queued past Bun's idle timeout still gets its answer", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async () => new Response('page', { headers: { 'cache-control': 'public, max-age=0, must-revalidate', 'content-type': 'text/html; charset=utf-8' } }) };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      idleTimeoutSeconds: 1,
      pace: testPace(1700, { cold: 4 }),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      // Bun's timer ticks every few seconds, so the last one waits well past a second.
      const answers = await Promise.all(
        ["/", "/en", "/history", "/en/history", "/status/main"].map(
          async (path) =>
            await fetch(`http://127.0.0.1:${result.server.port}${path}`).then(
              (each) => each.status,
              () => "closed"
            )
        )
      );
      expect(answers).toEqual([200, 200, 200, 200, 200]);
    } finally {
      await result.stop();
    }
  }, 20_000);

  test("thirty subscribers opening their pages at once all get them: a subscription's page refreshes in the visitors' lane, never the cold one", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async () => { await Bun.sleep(20); return new Response('subscription', { headers: { 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(0, { cold: 0, others: 0 }),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const tokens: string[] = [];
      for (const address of ["a@example.test", "b@example.test"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one sign-up at a time
        const stored = await result.storage.subscriptions.request({
          address,
          channel: "email",
          credentials: undefined,
          locale: "ar",
          pageId: created.page.id,
          quietSince: 0,
          requestedAt: Date.now(),
        });
        tokens.push(stored?.token ?? "");
      }
      const answers = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          fetch(
            `http://127.0.0.1:${result.server.port}/subscriptions/${tokens[i % 2]}`
          ).then((each) => each.status)
        )
      );
      expect(new Set(answers)).toEqual(new Set([200]));
    } finally {
      await result.stop();
    }
  });

  test("a stranger's made-up months and ids are checked one at a time in a lane of their own, before their not-found", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async () => new Response('<html><body>not found</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 404 }) };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(0, {}, { gapMs: 200, waiting: 2 }),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const paths = [
        ...Array.from({ length: 6 }, (_, i) => `/history/200${i}-01`),
        ...Array.from({ length: 6 }, (_, i) => `/incidents/made-up-${i}`),
      ];
      const answers = await Promise.all(
        paths.map((path) =>
          fetch(`http://127.0.0.1:${result.server.port}${path}`).then(
            (each) => each.status
          )
        )
      );
      expect(answers.filter((status) => status === 503).length).toBeGreaterThan(
        6
      );
      expect(answers.every((status) => status === 404 || status === 503)).toBe(
        true
      );
    } finally {
      await result.stop();
    }
  });

  test("while the change counter moves faster than refreshes land, a stranger's view of a kept address is answered at once from memory, never a 503", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "let renders = 0; export default { fetch: async () => { renders += 1; const n = renders; await Bun.sleep(300); return new Response('render ' + n, { headers: { 'cache-control': 'public, max-age=0, must-revalidate', 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(300, { refresh: 2 }),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const kept = ["/", "/en", "/history", "/en/history", "/badge.svg"];
      for (const path of kept) {
        // biome-ignore lint/performance/noAwaitInLoops: each kept once, before the counter moves
        await fetch(`http://127.0.0.1:${result.server.port}${path}`);
      }
      const statuses: number[] = [];
      let slowest = 0;
      for (let round = 0; round < 3; round += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: the counter moves between rounds, as down checks move it
        await result.storage.bump();
        const answers = await Promise.all(
          Array.from({ length: 30 }, async (_, i) => {
            const started = performance.now();
            const answer = await fetch(
              `http://127.0.0.1:${result.server.port}${kept[i % kept.length]}`
            );
            await answer.arrayBuffer();
            slowest = Math.max(slowest, performance.now() - started);
            return answer.status;
          })
        );
        statuses.push(...answers);
      }
      expect(new Set(statuses)).toEqual(new Set([200]));
      expect(slowest).toBeLessThan(1000);
    } finally {
      await result.stop();
    }
  });

  test("a flood of one subscription's page leaves visitors their views, and a flood of made-up reset links and sign-in searches leaves a real reset link and the plain sign-in page", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => { await Bun.sleep(100); return new Response('page', { headers: { 'cache-control': new URL(r.url).pathname === '/' ? 'public, max-age=0, must-revalidate' : 'no-store', 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(100, {
        others: 1,
        refresh: 1,
        reset: 4,
        subscriptions: 1,
      }),
    });
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      const page = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!(created.ok && page.ok)) {
        throw new Error("seed");
      }
      await publish(result.storage, page.page.id);
      const subscription = await result.storage.subscriptions.request({
        address: "reader@example.test",
        channel: "email",
        credentials: undefined,
        locale: "ar",
        pageId: page.page.id,
        quietSince: 0,
        requestedAt: Date.now(),
      });
      const printed: string[] = [];
      await resetPasswordCommand(
        result.storage,
        booted.settings,
        { interactive: false },
        {
          askHidden: () => Promise.resolve(""),
          err: () => undefined,
          interactive: false,
          out: (line) => printed.push(line),
        }
      );
      const link = new URL(
        printed.find((line) => line.startsWith("http")) ?? ""
      );
      const at = (path: string) =>
        fetch(`http://127.0.0.1:${result.server.port}${path}`).then(
          (each) => each.status
        );
      await at("/");
      await at("/sign-in");
      await result.storage.bump();
      const [views, reset, signIn] = await Promise.all([
        Promise.all(Array.from({ length: 10 }, () => at("/"))),
        Promise.all([
          ...Array.from({ length: 10 }, (_, i) =>
            at(`/reset-password?token=made-up-${i}`)
          ),
          ...Array.from({ length: 10 }, (_, i) => at(`/sign-in?x=${i}`)),
          ...Array.from({ length: 10 }, () =>
            at(`/subscriptions/${subscription?.token ?? ""}`)
          ),
        ]).then(() => at(`${link.pathname}${link.search}`)),
        at("/sign-in"),
      ]);
      expect(new Set(views)).toEqual(new Set([200]));
      expect(reset).toBe(200);
      expect(signIn).toBe(200);
    } finally {
      await result.stop();
    }
  });

  test("a kept-alive connection closes at the idle timeout once answered, even after a 503, and a request joining a slow render keeps its connection until it lands", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async () => { await Bun.sleep(6000); return new Response('slow', { headers: { 'cache-control': 'public, max-age=0, must-revalidate', 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      idleTimeoutSeconds: 1,
      pace: testPace(0, {}),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const joined = await Promise.all(
        [1, 2].map(() =>
          fetch(`http://127.0.0.1:${result.server.port}/`).then(
            (each) => each.status,
            () => "closed"
          )
        )
      );
      expect(joined).toEqual([200, 200]);
      const closedAfter = await new Promise<number>((resolve) => {
        const started = performance.now();
        Bun.connect({
          hostname: "127.0.0.1",
          port: Number(result.server.port),
          socket: {
            close: () => resolve(performance.now() - started),
            data: () => undefined,
            error: () => resolve(-1),
            open: (socket) => {
              socket.write(
                "GET /sign-in?x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n"
              );
            },
          },
        }).catch(() => resolve(-1));
      });
      expect(closedAfter).toBeGreaterThan(0);
      expect(closedAfter).toBeLessThan(15_000);
    } finally {
      await result.stop();
    }
  }, 30_000);

  test("a flood that fills its lane's waiting room leaves another lane's room open, and a stranger's admin page load is sent on with no render", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "let renders = 0; export default { fetch: async (r) => { renders += 1; const n = renders; await Bun.sleep(200); return new Response('render ' + n + ' of ' + new URL(r.url).pathname, { headers: { 'cache-control': 'public, max-age=0, must-revalidate', 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(100, { cold: 2, others: 2 }),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const at = (path: string, headers: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${result.server.port}${path}`, {
          headers,
          redirect: "manual",
        });
      const [view, ...others] = await Promise.all([
        at("/"),
        ...Array.from({ length: 6 }, (_, i) => at(`/sign-in?x=${i}`)),
      ]);
      expect(view?.status).toBe(200);
      expect(
        others.filter((each) => each.status === 503).length
      ).toBeGreaterThanOrEqual(3);
      const cookies: Record<string, string>[] = [
        {},
        { cookie: "raaqeb.session_token=stale" },
      ];
      for (const headers of cookies) {
        // biome-ignore lint/performance/noAwaitInLoops: one request at a time
        const admin = await at("/admin/monitors", headers);
        expect(admin.status).toBe(307);
        expect(admin.headers.get("location")).toBe("/onboarding");
      }
      const download = await at("/admin/monitors/x/history.jsonl.zst");
      expect(await download.text()).toEndWith(
        " of /admin/monitors/x/history.jsonl.zst"
      );
    } finally {
      await result.stop();
    }
  });

  test("renders without a session take turns a gap apart and, past the waiting room, answer 503 to try again; a session's never wait", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async () => { await Bun.sleep(50); return new Response('page', { headers: { 'content-type': 'text/html; charset=utf-8' } }); } };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(300, { others: 1 }),
    });
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const at = (path: string, headers: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${result.server.port}${path}`, { headers });
      const started = performance.now();
      const [first, second, third] = await Promise.all([
        at("/forgot-password?x=1"),
        at("/forgot-password?x=2"),
        at("/forgot-password?x=3"),
      ]);
      const statuses = [first, second, third].map((each) => each.status);
      expect(statuses.toSorted((a, b) => a - b)).toEqual([200, 200, 503]);
      const refused = [first, second, third].find(
        (each) => each.status === 503
      );
      expect(refused?.headers.get("retry-after")).toBe("1");
      expect(performance.now() - started).toBeGreaterThanOrEqual(300);
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const cookie = created.setCookies
        .map((each) => each.split(";")[0])
        .join("; ");
      const signedIn = await Promise.all(
        [1, 2, 3].map(() => at("/admin/monitors", { cookie }))
      );
      expect(signedIn.map((each) => each.status)).toEqual([200, 200, 200]);
    } finally {
      await result.stop();
    }
  });

  test("a stranger's request carrying a body, past its group's places, is answered 503 before the handler reads it while another group has room; one with no body, the keyed APIs and a signed-in operator's pass", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => { if (r.method === 'GET') return new Response('got'); await Bun.sleep(400); return new Response('read ' + (await r.text()).length); } };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      { pace: testPace(0, {}, undefined, { others: 2, signIn: 1 }) }
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const session = created.setCookies
        .map((each) => each.split(";")[0])
        .join("; ");
      const at = (path: string, client: string, cookie?: string) =>
        fetch(`http://127.0.0.1:${result.server.port}${path}`, {
          body: "body",
          headers: {
            "x-forwarded-for": client,
            ...(cookie ? { cookie } : {}),
          },
          method: "POST",
        });
      const [a, b, c] = ["198.51.100.1", "198.51.100.2", "2001:db8::1"];
      const held = [at("/_serverFn/a", a), at("/_serverFn/b", b)];
      await Bun.sleep(100);
      const refused = await at("/_serverFn/c", c);
      expect(refused.status).toBe(503);
      expect(refused.headers.get("retry-after")).toBe("1");
      expect(
        (await at("/_serverFn/d", c, "raaqeb.session_token=forged.sig")).status
      ).toBe(503);
      // Sign-in has places of its own while the other functions' are full, until they are taken too.
      held.push(at("/api/auth/sign-in/email", c));
      await Bun.sleep(100);
      expect((await at("/api/auth/sign-in/email", a)).status).toBe(503);
      const passing = await Promise.all([
        fetch(`http://127.0.0.1:${result.server.port}/_serverFn/f`),
        at("/api/v1/monitors", c),
        at("/api/probe/v1/results", c),
        at("/_serverFn/g", a, session),
      ]);
      expect(await Promise.all(passing.map((each) => each.text()))).toEqual([
        "got",
        "read 4",
        "read 4",
        "read 4",
      ]);
      expect(
        await Promise.all((await Promise.all(held)).map((each) => each.text()))
      ).toEqual(["read 4", "read 4", "read 4"]);
      // Answered, they leave the budget.
      expect(await (await at("/_serverFn/h", a)).text()).toBe("read 4");
    } finally {
      await result.stop();
    }
  });

  test("four clients each holding sixteen unfinished bodies to the subscribe function leave another stranger's sign-in and heartbeat failure report answered, and subscribing too once their bodies pass the deadline", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir
    );
    if (typeof result === "number") {
      throw new Error("expected a server");
    }
    const origin = `http://127.0.0.1:${result.server.port}`;
    const token = await heartbeatToken(result.storage);
    const held: Bun.Socket[] = [];
    try {
      // Each declares 100 bytes, sends 2 and stalls, as the flood in the report did.
      for (const client of [1, 2, 3, 4]) {
        for (let each = 0; each < 16; each += 1) {
          held.push(
            // biome-ignore lint/performance/noAwaitInLoops: one connection after another, as a flood opens them
            await Bun.connect({
              hostname: "127.0.0.1",
              port: result.server.port ?? 0,
              socket: {
                data: () => undefined,
                open: (socket) => {
                  socket.write(
                    `POST ${subscribePath} HTTP/1.1\r\nhost: x\r\nx-forwarded-for: 198.51.100.${client}\r\ncontent-length: 100\r\n\r\nab`
                  );
                },
              },
            })
          );
        }
      }
      await Bun.sleep(300);
      const from = (path: string, client: string) =>
        fetch(`${origin}${path}`, {
          body: "body",
          headers: { "x-forwarded-for": client },
          method: "POST",
        });
      const [signIn, failure] = await Promise.all([
        from("/api/auth/sign-in/email", "198.51.100.9"),
        from(`/api/heartbeat/${token}/fail`, "198.51.100.10"),
      ]);
      expect([signIn.status, failure.status]).toEqual([200, 200]);
      await Bun.sleep(2500);
      expect(await (await from(subscribePath, "198.51.100.11")).text()).toBe(
        "read 4"
      );
    } finally {
      for (const socket of held) {
        socket.end();
      }
      await result.stop();
    }
  });

  test("a stranger past its rule's bucket is answered 429 with the seconds to its next token, unread and taking no place, while another client and another rule have their own and a session passes; a browser's post from another site is 403 and spends nothing but at a heartbeat", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => { const text = await r.text(); await Bun.sleep(r.headers.has('x-hold') ? 300 : 0); return new Response('read ' + text.length); } };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      {
        pace: testPace(
          0,
          {},
          undefined,
          { signIn: 1 },
          {
            heartbeat: { capacity: 1, everyMs: 60_000 },
            others: { capacity: 1, everyMs: 60_000 },
            signIn: { capacity: 2, everyMs: 10_000 },
          }
        ),
      }
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const session = created.setCookies
        .map((each) => each.split(";")[0])
        .join("; ");
      const at = (
        path: string,
        client: string,
        headers: Record<string, string> = {},
        method = "POST"
      ) =>
        fetch(`http://127.0.0.1:${result.server.port}${path}`, {
          body: method === "POST" ? "body" : undefined,
          headers: { "x-forwarded-for": client, ...headers },
          method,
        });
      const [a, b] = ["198.51.100.1", "2001:db8:0:1::1"];
      const failure = `/api/heartbeat/${await heartbeatToken(result.storage)}/fail`;
      const signIn = "/api/auth/sign-in/email";
      const crossSite = { "sec-fetch-site": "cross-site" };
      // A post from another site is refused before it costs anything.
      expect((await at(signIn, a, crossSite)).status).toBe(403);
      expect(await (await at(signIn, a)).text()).toBe("read 4");
      expect(await (await at(signIn, a)).text()).toBe("read 4");
      const refused = await at(signIn, a);
      expect([refused.status, await refused.text()]).toEqual([
        429,
        "Too Many Requests",
      ]);
      expect(refused.headers.get("retry-after")).toBe("10");
      expect(refused.headers.get("cache-control")).toBe("no-store");
      // Unread and placeless: the one sign-in place is still free for another client, counted by its /64.
      const held = at(signIn, b, { "x-hold": "1" });
      await Bun.sleep(50);
      expect((await at(signIn, "2001:db8:0:1::2")).status).toBe(503);
      expect(await (await held).text()).toBe("read 4");
      expect(await (await at("/_serverFn/x", a)).text()).toBe("read 4");
      expect((await at("/_serverFn/x", a)).status).toBe(429);
      // A session's save passes the spent bucket; its sign-in would not (a test below).
      expect(
        await (await at("/_serverFn/x", a, { cookie: session })).text()
      ).toBe("read 4");
      // Better Auth's other addresses are counted too, with no body and no place.
      expect((await at("/api/auth/callback/x", b, {}, "GET")).status).not.toBe(
        429
      );
      expect((await at("/api/auth/callback/x", b, {}, "GET")).status).toBe(429);
      // A heartbeat takes a post from anywhere a job runs, counted by its token wherever it comes from; a made-up token is not found.
      expect(await (await at(failure, "198.51.100.3", crossSite)).text()).toBe(
        "read 4"
      );
      expect((await at(failure, b)).status).toBe(429);
      expect(
        (await at("/api/heartbeat/aaaaaaaaaaaaaaaaaaaaaa/fail", "198.51.100.4"))
          .status
      ).toBe(404);
      // A database that cannot answer is no answer about the token: 503, as the route says then.
      await result.storage.close();
      expect(
        (await at("/api/heartbeat/bbbbbbbbbbbbbbbbbbbbbb/fail", "198.51.100.5"))
          .status
      ).toBe(503);
    } finally {
      await result.stop();
    }
  });

  test("the shipped rules: six sign-ins and second steps together, then one every ten seconds; three reset emails a minute; five subscriptions, then one every two minutes; ten page password tries; thirty heartbeat failure reports; twenty of anything else, single sign-on's start included, so a team behind one address starts eight", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir
    );
    if (typeof result === "number") {
      throw new Error("expected a server");
    }
    const token = await heartbeatToken(result.storage);
    try {
      /** The statuses of `count` posts to each path in turn from one client, then the seconds the next refusal names. */
      const run = async (client: string, paths: string[], count: number) => {
        const statuses: number[] = [];
        for (let each = 0; each < count; each += 1) {
          for (const path of paths) {
            // biome-ignore lint/performance/noAwaitInLoops: the bucket counts in order
            const answer = await fetch(
              `http://127.0.0.1:${result.server.port}${path}`,
              {
                body: "body",
                headers: { "x-forwarded-for": client },
                method: "POST",
              }
            );
            statuses.push(answer.status);
            await answer.arrayBuffer();
          }
        }
        const next = await fetch(
          `http://127.0.0.1:${result.server.port}${paths[0]}`,
          {
            body: "body",
            headers: { "x-forwarded-for": client },
            method: "POST",
          }
        );
        return {
          next: [next.status, next.headers.get("retry-after")],
          passed: statuses.filter((status) => status === 200).length,
        };
      };
      expect(
        await run(
          "198.51.100.1",
          [
            "/api/auth/sign-in/email",
            "/api/auth/two-factor/verify-totp",
            "/api/auth/invitation/accept",
          ],
          2
        )
      ).toEqual({ next: [429, "10"], passed: 6 });
      expect(
        await run("198.51.100.2", ["/api/auth/request-password-reset"], 3)
      ).toEqual({ next: [429, "60"], passed: 3 });
      expect(await run("198.51.100.3", [subscribePath], 5)).toEqual({
        next: [429, "120"],
        passed: 5,
      });
      expect(await run("198.51.100.4", ["/status/main"], 10)).toEqual({
        next: [429, "6"],
        passed: 10,
      });
      expect(
        await run("198.51.100.5", [`/api/heartbeat/${token}/fail`], 30)
      ).toEqual({ next: [429, "2"], passed: 30 });
      expect(
        await run(
          "198.51.100.6",
          ["/api/auth/sign-in/social", "/_serverFn/other"],
          10
        )
      ).toEqual({ next: [429, "1"], passed: 20 });
    } finally {
      await result.stop();
    }
  });

  test("when a group's places are full, a newcomer takes the place of the oldest body still arriving, which is answered 408 at once; a group of bodies that arrived refuses with 503", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => { const text = await r.text(); await Bun.sleep(r.headers.has('x-hold') ? 400 : 0); return new Response('read ' + text.length); } };",
    });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      { pace: testPace(0, {}, undefined, { forms: 1 }, {}, 10_000) }
    );
    if (typeof result === "number") {
      throw new Error("expected a server");
    }
    const origin = `http://127.0.0.1:${result.server.port}`;
    try {
      const started = performance.now();
      const trickle = new Promise<string>((resolve) => {
        let text = "";
        Bun.connect({
          hostname: "127.0.0.1",
          port: result.server.port ?? 0,
          socket: {
            close: () => resolve(text),
            data: (_socket, chunk) => {
              text += chunk.toString();
            },
            open: (socket) => {
              socket.write(
                `POST ${subscribePath} HTTP/1.1\r\nhost: x\r\nx-forwarded-for: 198.51.100.1\r\ncontent-length: 100\r\n\r\nab`
              );
            },
          },
        });
      });
      await Bun.sleep(200);
      const at = (client: string, headers: Record<string, string> = {}) =>
        fetch(`${origin}${subscribePath}`, {
          body: "body",
          headers: { "x-forwarded-for": client, ...headers },
          method: "POST",
        });
      const newcomer = at("198.51.100.2", { "x-hold": "1" });
      expect(await trickle).toStartWith("HTTP/1.1 408");
      // Long before its deadline of ten seconds.
      expect(performance.now() - started).toBeLessThan(2000);
      await Bun.sleep(100);
      // The one place holds a body that arrived: nothing gives way.
      expect((await at("198.51.100.3")).status).toBe(503);
      expect(await (await newcomer).text()).toBe("read 4");
    } finally {
      await result.stop();
    }
  });

  test("an IPv6 site's /64s share four networks' worth of a rule between them, and another site has its own", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      {
        pace: testPace(
          0,
          {},
          undefined,
          {},
          { signIn: { capacity: 1, everyMs: 60_000 } }
        ),
      }
    );
    if (typeof result === "number") {
      throw new Error("expected a server");
    }
    try {
      const from = async (client: string) =>
        (
          await fetch(
            `http://127.0.0.1:${result.server.port}/api/auth/sign-in/email`,
            {
              body: "body",
              headers: { "x-forwarded-for": client },
              method: "POST",
            }
          )
        ).status;
      const site = [1, 2, 3, 4, 5].map((n) => `2001:db8:1:${n}::1`);
      const statuses: number[] = [];
      for (const client of site) {
        // biome-ignore lint/performance/noAwaitInLoops: the buckets count in order
        statuses.push(await from(client));
      }
      expect(statuses).toEqual([200, 200, 200, 200, 429]);
      expect(await from("2001:db8:2:1::1")).toBe(200);
    } finally {
      await result.stop();
    }
  });

  test("a browser known for an account signs in on an allowance of its own, and past sign-in's full places; opening an open reset link makes a browser known for its account, a closed one does not", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => { const text = await r.text(); await Bun.sleep(r.headers.has('x-hold') ? 400 : 0); return new Response(r.method === 'GET' ? '<html></html>' : 'read ' + text.length, { headers: { 'content-type': 'text/html' } }); } };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      {
        pace: testPace(
          0,
          {},
          undefined,
          { signIn: 1 },
          {
            signIn: { capacity: 1, everyMs: 60_000 },
            subscribe: { capacity: 1, everyMs: 60_000 },
          }
        ),
      }
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    const origin = `http://127.0.0.1:${result.server.port}`;
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const auth = await authFor(result.storage, booted.settings);
      const { internalAdapter } = await auth.$context;
      const account = await internalAdapter.findUserByEmail(
        "operator@example.com"
      );
      await internalAdapter.createVerificationValue({
        expiresAt: new Date(Date.now() + 60_000),
        identifier: "reset-password:open-link",
        value: account?.user.id ?? "",
      });
      const page = (token: string) =>
        fetch(`${origin}/reset-password?token=${token}`, {
          headers: { "x-forwarded-for": "198.51.100.9" },
        });
      const known = (await page("open-link")).headers
        .getSetCookie()
        .find((each) => each.startsWith("raaqeb.known="))
        ?.split(";")[0];
      expect(known).toBeDefined();
      expect(
        (await page("closed-link")).headers
          .getSetCookie()
          .some((each) => each.startsWith("raaqeb.known="))
      ).toBe(false);
      const signIn = (client: string, headers: Record<string, string> = {}) =>
        fetch(`${origin}/api/auth/sign-in/email`, {
          body: "body",
          headers: { "x-forwarded-for": client, ...headers },
          method: "POST",
        });
      // A stranger on the same network holds sign-in's one place and has spent the network's allowance.
      const held = signIn("198.51.100.9", { "x-hold": "1" });
      await Bun.sleep(100);
      expect((await signIn("198.51.100.9")).status).toBe(429);
      expect((await signIn("198.51.100.10")).status).toBe(503);
      expect(
        await (await signIn("198.51.100.9", { cookie: known ?? "" })).text()
      ).toBe("read 4");
      expect(await (await held).text()).toBe("read 4");
      // On a network of its own it spends the network's allowance first, then its own: two, then none.
      const fresh = () =>
        signIn("198.51.100.12", { cookie: known ?? "" }).then(
          (answer) => answer.status
        );
      expect([await fresh(), await fresh(), await fresh()]).toEqual([
        200, 429, 429,
      ]);
      // The cookie counts at sign-in alone: its network's spent subscribing stays spent.
      const subscribe = (headers: Record<string, string> = {}) =>
        fetch(`${origin}${subscribePath}`, {
          body: "body",
          headers: { "x-forwarded-for": "198.51.100.11", ...headers },
          method: "POST",
        });
      expect((await subscribe()).status).toBe(200);
      expect((await subscribe({ cookie: known ?? "" })).status).toBe(429);
    } finally {
      await result.stop();
    }
  });

  test("every spelling of an action counts against that action's rule, and a spelling the entry cannot name against the strictest: five sign-ups a client at the subscribe function however its address is written, three where it cannot be named, and the reset email's and sign-in's rows likewise", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir
    );
    if (typeof result === "number") {
      throw new Error("expected a server");
    }
    try {
      let clients = 0;
      /** How many of `count` posts to the raw address, sent over a socket as written, reach the handler, from a client of its own. */
      const reached = async (
        address: string,
        count = 8,
        passes = (answer: string) => answer.includes("read 4")
      ) => {
        clients += 1;
        const client = `198.51.100.${clients}`;
        let passed = 0;
        for (let each = 0; each < count; each += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: the bucket counts in order
          const answer = await new Promise<string>((resolve) => {
            let text = "";
            Bun.connect({
              hostname: "127.0.0.1",
              port: result.server.port ?? 0,
              socket: {
                close: () => resolve(text),
                data: (socket, chunk) => {
                  text += chunk.toString();
                  socket.end();
                },
                open: (socket) => {
                  socket.write(
                    `POST ${address} HTTP/1.1\r\nhost: x\r\nx-forwarded-for: ${client}\r\nconnection: close\r\ncontent-length: 4\r\n\r\nbody`
                  );
                },
              },
            });
          });
          if (passes(answer)) {
            passed += 1;
          }
        }
        return passed;
      };
      const spellings: [string, number][] = [
        [subscribePath, 5],
        [`${subscribePath}/x`, 5],
        [`${subscribePath}/`, 5],
        [`${subscribePath}?a=1`, 5],
        [`${subscribePath}/x/y?a=1`, 5],
        ["/_serverFn/routes.-subscriptions%2D-subscribeFn", 3],
        ["/_serverFn//routes.-subscriptions--subscribeFn", 3],
        // A request-target starting with two slashes is answered before the app.
        [`/${subscribePath}`, 0],
        ["/api/auth/request-password-reset", 3],
        ["/api/auth/request-password-reset/", 3],
        ["/api/auth/request-password-reset?a=1", 3],
        ["/api/auth/request%2Dpassword-reset", 3],
        ["/api/auth/sign-in/email", 6],
        ["/api/auth/sign-in/email/", 6],
        ["/API/AUTH/sign-in/email", 6],
      ];
      const counts: [string, number][] = [];
      for (const [address] of spellings) {
        // biome-ignore lint/performance/noAwaitInLoops: one spelling after another, each from a client of its own
        counts.push([address, await reached(address)]);
      }
      expect(counts).toEqual(spellings);
      // Any other API address, and the functions' base in another letter case, is "anything else": twenty, where a status page's address takes ten.
      const notRefused = (answer: string) => !answer.startsWith("HTTP/1.1 429");
      expect([
        await reached("/api/other", 22, notRefused),
        await reached("/_SERVERFN/x", 22, notRefused),
        await reached("/status/main", 22, notRefused),
      ]).toEqual([20, 20, 10]);
      // A heartbeat in any letter case is the heartbeat: a token no monitor has is not found before its body.
      expect(
        await reached("/API/HEARTBEAT/aaaaaaaaaaaaaaaaaaaaaa/fail", 1)
      ).toBe(0);
    } finally {
      await result.stop();
    }
  });

  test("the sign-up limit holds by client as the removed limiter held it: a /64 is one client, an IPv4 address written in IPv6 is that address, and clients with no address the entry can know share one", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir
    );
    if (typeof result === "number") {
      throw new Error("expected a server");
    }
    try {
      const from = async (forwarded: string) =>
        (
          await fetch(
            `http://127.0.0.1:${result.server.port}${subscribePath}`,
            {
              body: "body",
              headers: { "x-forwarded-for": forwarded },
              method: "POST",
            }
          )
        ).status;
      const five = async (clients: string[]) => {
        const statuses: number[] = [];
        for (const client of clients) {
          // biome-ignore lint/performance/noAwaitInLoops: the bucket counts in order
          statuses.push(await from(client));
        }
        return statuses;
      };
      expect(
        await five([
          "2001:db8:1:2::1",
          "2001:db8:1:2:ffff::9",
          "2001:0db8:0001:0002:abcd::1",
          "2001:db8:1:2::2",
          "2001:db8:1:2::3",
          "2001:db8:1:2::4",
        ])
      ).toEqual([200, 200, 200, 200, 200, 429]);
      expect(await from("2001:db8:1:3::1")).toBe(200);
      expect(
        await five([
          "::ffff:10.0.0.1",
          "10.0.0.1",
          "::ffff:10.0.0.1",
          "10.0.0.1",
          "::ffff:10.0.0.1",
          "10.0.0.1",
        ])
      ).toEqual([200, 200, 200, 200, 200, 429]);
      expect(
        await five(["not an address", "nor this", "x", "y", "z", "w"])
      ).toEqual([200, 200, 200, 200, 200, 429]);
    } finally {
      await result.stop();
    }
  });

  test("one IPv6 /48 cycling its /64s leaves the table room: past its site's allowance a refused request adds no client, so a stranger elsewhere has a bucket of their own, and a known browser's sign-in never depends on the table", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      {
        pace: testPace(
          0,
          {},
          undefined,
          {},
          {
            signIn: strangerPace.rates.signIn,
            subscribe: strangerPace.rates.subscribe,
          },
          strangerPace.bodyDeadlineMs,
          50
        ),
      }
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    const origin = `http://127.0.0.1:${result.server.port}`;
    try {
      const [known] = (
        await knownBrowsersOf(result.storage).cookie(
          booted.settings.installKey,
          "operator@example.com",
          false
        )
      ).split(";");
      const post = (path: string, client: string, cookie = "") =>
        fetch(`${origin}${path}`, {
          body: "body",
          headers: { cookie, "x-forwarded-for": client },
          method: "POST",
        }).then((answer) => answer.status);
      for (let each = 0; each < 300; each += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one /64 after another, as a flood cycles them
        await post(subscribePath, `2001:db8:0:${each.toString(16)}::1`);
      }
      // Other strangers arriving meanwhile, each a client the table has not seen.
      const strangers: number[] = [];
      for (let each = 0; each < 8; each += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one after another
        const status = await post(
          "/api/auth/sign-in/email",
          `198.51.100.${each + 1}`
        );
        strangers.push(status);
      }
      expect(strangers).toEqual(new Array(8).fill(200));
      expect(
        await post("/api/auth/sign-in/email", "203.0.113.9", known ?? "")
      ).toBe(200);
    } finally {
      await result.stop();
    }
  });

  test("a known browser's own allowance is its account's, however many cookies signing in has given it, and past full places its body still has the deadline; every post under /api/auth/ counts by its address, a code request with no body too", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => { const text = await r.text(); await Bun.sleep(r.headers.has('x-hold') ? 1500 : 0); return new Response('read ' + text.length); } };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      {
        pace: testPace(
          0,
          {},
          undefined,
          { signIn: 1 },
          { signIn: { capacity: 1, everyMs: 60_000 } },
          300
        ),
      }
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    const origin = `http://127.0.0.1:${result.server.port}`;
    const { storage } = result;
    try {
      // Each sign-in gives the browser a new cookie for the same account.
      const cookies = await Promise.all(
        [1, 2, 3].map(async () => {
          const [pair] = (
            await knownBrowsersOf(storage).cookie(
              booted.settings.installKey,
              "account-1",
              false
            )
          ).split(";");
          return pair ?? "";
        })
      );
      const post = (
        path: string,
        client: string,
        headers: Record<string, string> = {},
        body: string | undefined = "body"
      ) =>
        fetch(`${origin}${path}`, {
          body,
          headers: { "x-forwarded-for": client, ...headers },
          method: "POST",
        }).then((answer) => answer.status);
      const signIn = "/api/auth/sign-in/email";
      expect(await post(signIn, "198.51.100.1")).toBe(200);
      const statuses: number[] = [];
      for (const cookie of cookies) {
        // biome-ignore lint/performance/noAwaitInLoops: the bucket counts in order
        statuses.push(await post(signIn, "198.51.100.1", { cookie }));
      }
      expect(statuses).toEqual([200, 429, 429]);
      // Past full places, a known browser's trickling body is cut at the deadline like a stranger's.
      const [other] = (
        await knownBrowsersOf(storage).cookie(
          booted.settings.installKey,
          "account-2",
          false
        )
      ).split(";");
      const held = post(signIn, "198.51.100.2", { "x-hold": "1" });
      await Bun.sleep(100);
      expect(await post(signIn, "198.51.100.3")).toBe(503);
      const trickle = await new Promise<string>((resolve) => {
        let text = "";
        Bun.connect({
          hostname: "127.0.0.1",
          port: result.server.port ?? 0,
          socket: {
            close: () => resolve(text),
            data: (_socket, chunk) => {
              text += chunk.toString();
            },
            open: async (socket) => {
              socket.write(
                `POST ${signIn} HTTP/1.1\r\nhost: x\r\nx-forwarded-for: 198.51.100.2\r\ncookie: ${other}\r\nconnection: close\r\ncontent-length: 10\r\n\r\n`
              );
              for (let each = 0; each < 10; each += 1) {
                // biome-ignore lint/performance/noAwaitInLoops: a byte at a time
                await Bun.sleep(100);
                socket.write("x");
              }
            },
          },
        });
      });
      expect(trickle).toStartWith("HTTP/1.1 408");
      expect(await held).toBe(200);
      // A code request sends mail with or without a body: the sign-in row counts both.
      const sendCode = "/api/auth/two-factor/send-otp";
      expect([
        await post(sendCode, "198.51.100.9", {}, undefined),
        await post(sendCode, "198.51.100.9", {}, undefined),
      ]).toEqual([200, 429]);
    } finally {
      await result.stop();
    }
  });

  test("opening an open invitation makes no browser known: the sign-in that accepting it makes does", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const owner = await result.storage.operatorAccounts.findByEmail(
        "operator@example.com"
      );
      const token = newInvitationToken();
      await result.storage.invitations.put({
        createdAt: Date.now(),
        email: "new@example.com",
        expiresAt: Date.now() + 60_000,
        id: crypto.randomUUID(),
        invitedBy: owner?.id ?? null,
        role: "editor",
        tokenHash: invitationTokenHash(token),
      });
      const opened = await fetch(
        `http://127.0.0.1:${result.server.port}/invitation?token=${token}`,
        { headers: { "x-forwarded-for": "198.51.100.9" } }
      );
      expect(opened.status).toBe(200);
      expect(
        opened.headers
          .getSetCookie()
          .some((each) => each.startsWith("raaqeb.known="))
      ).toBe(false);
    } finally {
      await result.stop();
    }
  });

  test("a live session spends Better Auth's rows like anyone: a sign-in or a reset email from a signed-in browser is counted, since each spends a password check or sends mail", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      {
        pace: testPace(
          0,
          {},
          undefined,
          {},
          {
            resetMail: { capacity: 1, everyMs: 60_000 },
            signIn: { capacity: 1, everyMs: 60_000 },
          }
        ),
      }
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const cookie = created.setCookies
        .map((each) => each.split(";")[0])
        .join("; ");
      const post = (path: string) =>
        fetch(`http://127.0.0.1:${result.server.port}${path}`, {
          body: "body",
          headers: { cookie, "x-forwarded-for": "198.51.100.1" },
          method: "POST",
        }).then((answer) => answer.status);
      expect([
        await post("/api/auth/sign-in/email"),
        await post("/api/auth/sign-in/email"),
        await post("/api/auth/request-password-reset"),
        await post("/api/auth/request-password-reset"),
      ]).toEqual([200, 429, 200, 429]);
    } finally {
      await result.stop();
    }
  });

  test("a live session subscribing is counted like a visitor, and so are its requests to Better Auth's addresses with no body: only a save goes on uncounted", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const cookie = created.setCookies
        .map((each) => each.split(";")[0])
        .join("; ");
      const send = async (path: string, method: string, count: number) => {
        const statuses: number[] = [];
        for (let each = 0; each < count; each += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: the bucket counts in order
          const answer = await fetch(
            `http://127.0.0.1:${result.server.port}${path}`,
            {
              body: method === "POST" ? "body" : undefined,
              headers: { cookie, "x-forwarded-for": "198.51.100.1" },
              method,
            }
          );
          statuses.push(answer.status);
        }
        return statuses;
      };
      const subscribed = await send(subscribePath, "POST", 6);
      expect(subscribed).toEqual([200, 200, 200, 200, 200, 429]);
      const callbacks = await send("/api/auth/callback/x", "GET", 21);
      expect(callbacks.at(-1)).toBe(429);
      expect(await send("/_serverFn/save", "POST", 30)).toEqual(
        new Array(30).fill(200)
      );
    } finally {
      await result.stop();
    }
  });

  test("a viewer's saves that send mail or check a password are counted for the account, from any network: five mails then one every two minutes, six password checks then one every ten seconds; another account has its own, and other saves go on uncounted", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const owner = created.setCookies
        .map((each) => each.split(";")[0])
        .join("; ");
      const auth = await authFor(result.storage, booted.settings);
      const body = {
        email: "viewer@example.com",
        password: "viewer password one",
      };
      await auth.api.signUpEmail({ body: { ...body, name: "Viewer" } });
      expect(
        (await result.storage.operatorAccounts.findByEmail(body.email))?.role
      ).toBe("viewer");
      const viewer = (
        await auth.api.signInEmail({ body, returnHeaders: true })
      ).headers
        .getSetCookie()
        .map((each) => each.split(";")[0])
        .join("; ");
      const send = async (
        id: string,
        count: number,
        cookie: string,
        from: string
      ) => {
        const statuses: number[] = [];
        for (let each = 0; each < count; each += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: the bucket counts in order
          const answer = await fetch(
            `http://127.0.0.1:${result.server.port}/_serverFn/${id}`,
            {
              body: "body",
              headers: { cookie, "x-forwarded-for": from },
              method: "POST",
            }
          );
          statuses.push(answer.status);
        }
        return statuses;
      };
      const settings = "routes.admin.settings";
      // Three test messages from one network, then two more and a change of address from another: one account, one count.
      expect(
        await send(`${settings}.sign-in--test`, 3, viewer, "198.51.100.1")
      ).toEqual([200, 200, 200]);
      expect(
        await send(`${settings}.sign-in--test`, 2, viewer, "203.0.113.1")
      ).toEqual([200, 200]);
      expect(
        await send(`${settings}.account--changeEmail`, 1, viewer, "203.0.113.1")
      ).toEqual([429]);
      // Better Auth trims a cookie's name, spaces and a no-break space included, so each spelling is the same session and the same count.
      for (const spelled of [
        viewer.replace("raaqeb.session_token=", "raaqeb.session_token ="),
        viewer.replace(
          "raaqeb.session_token=",
          "\u00a0raaqeb.session_token\t="
        ),
      ]) {
        expect(
          // biome-ignore lint/performance/noAwaitInLoops: one spelling after the other, the count spent
          await send(`${settings}.sign-in--test`, 1, spelled, "203.0.113.50")
        ).toEqual([429]);
      }
      expect(
        await send(
          `${settings}.account--changePassword`,
          7,
          viewer,
          "203.0.113.2"
        )
      ).toEqual([200, 200, 200, 200, 200, 200, 429]);
      for (const id of [
        "sign-in--change",
        "sign-in--setUp",
        "sign-in--appOff",
        "sign-in--newCodes",
      ]) {
        expect(
          // biome-ignore lint/performance/noAwaitInLoops: each after the account's password checks are spent
          await send(`${settings}.${id}`, 1, viewer, "198.51.100.9")
        ).toEqual([429]);
      }
      // The owner's own count, from the viewer's network.
      expect(
        await send(`${settings}.sign-in--test`, 6, owner, "198.51.100.1")
      ).toEqual([200, 200, 200, 200, 200, 429]);
      expect(
        await send(
          `${settings}.account--changeName`,
          30,
          viewer,
          "198.51.100.1"
        )
      ).toEqual(new Array(30).fill(200));
    } finally {
      await result.stop();
    }
  });

  test("every save counted for an account names a server function the build gives that id, so a rename cannot drop its count", async () => {
    for (const id of accountSaves.keys()) {
      const [module = "", name = ""] = id.split("--");
      // biome-ignore lint/performance/noAwaitInLoops: one file at a time
      const source = await Bun.file(`src/${module.replaceAll(".", "/")}.tsx`)
        .text()
        .catch(() => "");
      expect(source).toContain(`const ${name} = createServerFn(`);
    }
  });

  test("a live session's post is the session's: no rule counts it, no deadline cuts a slow one, and no stranger's newcomer takes its place", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      { pace: testPace(0, {}, undefined, { others: 1 }, {}, 300) }
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const session = created.setCookies
        .map((each) => each.split(";")[0])
        .join("; ");
      // A save sent a few bytes at a time over a second, from a slow link.
      const slowSave = new Promise<string>((resolve) => {
        let text = "";
        Bun.connect({
          hostname: "127.0.0.1",
          port: result.server.port ?? 0,
          socket: {
            close: () => resolve(text),
            data: (_socket, chunk) => {
              text += chunk.toString();
            },
            open: async (socket) => {
              socket.write(
                `POST /_serverFn/save HTTP/1.1\r\nhost: x\r\ncookie: ${session}\r\nconnection: close\r\ncontent-length: 10\r\n\r\n`
              );
              for (let each = 0; each < 10; each += 1) {
                // biome-ignore lint/performance/noAwaitInLoops: a byte at a time, as a slow link sends them
                await Bun.sleep(100);
                socket.write("x");
              }
            },
          },
        });
      });
      await Bun.sleep(150);
      // A stranger's post while the save arrives: the one place is free for it.
      const stranger = await fetch(
        `http://127.0.0.1:${result.server.port}/_serverFn/other`,
        {
          body: "body",
          headers: { "x-forwarded-for": "198.51.100.1" },
          method: "POST",
        }
      );
      expect(await stranger.text()).toBe("read 4");
      expect(await slowSave).toContain("read 10");
    } finally {
      await result.stop();
    }
  });

  test("a live session's body past a stranger's limit is a save's alone: at sign-in or subscribing it is refused unread, so a trickle there holds no place a stranger needs", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      { pace: testPace(0, {}, undefined, { forms: 1, signIn: 1 }, {}, 300) }
    );
    if (typeof result === "number" || !result.storage || !booted.ok) {
      throw new Error("expected a server over a database");
    }
    const port = result.server.port ?? 0;
    try {
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "http://raaqeb.test",
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage: result.storage,
        },
        new Headers({ origin: "http://raaqeb.test" })
      );
      if (!created.ok) {
        throw new Error("the account was not created");
      }
      const session = created.setCookies
        .map((each) => each.split(";")[0])
        .join("; ");
      /** The answer to a session's post declaring 100 KB and sending a byte every 100 ms for a second, or what arrived by then. */
      const trickle = (path: string) =>
        new Promise<string>((resolve) => {
          let text = "";
          Bun.connect({
            hostname: "127.0.0.1",
            port,
            socket: {
              close: () => resolve(text),
              data: (_socket, chunk) => {
                text += chunk.toString();
              },
              open: async (socket) => {
                socket.write(
                  `POST ${path} HTTP/1.1\r\nhost: x\r\ncookie: ${session}\r\nx-forwarded-for: 198.51.100.9\r\ncontent-length: 100000\r\n\r\n`
                );
                for (let each = 0; each < 10; each += 1) {
                  // biome-ignore lint/performance/noAwaitInLoops: a byte at a time, as a trickle sends them
                  await Bun.sleep(100);
                  socket.write("x");
                }
                socket.end();
                resolve(text);
              },
            },
          });
        });
      const strangerAt = async (path: string) =>
        (
          await fetch(`http://127.0.0.1:${port}${path}`, {
            body: "body",
            headers: { "x-forwarded-for": "198.51.100.1" },
            method: "POST",
          })
        ).status;
      for (const path of [
        "/api/auth/sign-in/email",
        "/_serverFn/routes.-subscriptions--subscribeFn",
      ]) {
        const held = trickle(path);
        // biome-ignore lint/performance/noAwaitInLoops: one row after the other, each with its place held
        await Bun.sleep(200);
        // The one place of the row is free for a stranger while the session's trickle goes on.
        expect(await strangerAt(path)).toBe(200);
        expect(await held).toContain("413 Payload Too Large");
      }
      // A save takes the session's whole allowance, as before.
      const save = await fetch(`http://127.0.0.1:${port}/_serverFn/save`, {
        body: "x".repeat(100_000),
        headers: { cookie: session },
        method: "POST",
      });
      expect(await save.text()).toBe("read 100000");
    } finally {
      await result.stop();
    }
  });

  test("a stranger's body that has not arrived whole by the deadline is answered 408 and its connection closed, over HTTP/1.1 and HTTP/2, though it sends a byte every 100 ms; one that arrives in time is read whole", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r) => new Response('read ' + (await r.text()).length) };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(0, {}, undefined, {}, {}, 500),
    });
    if (typeof result === "number") {
      throw new Error("expected a server");
    }
    const origin = `http://127.0.0.1:${result.server.port}`;
    try {
      const started = performance.now();
      const overHttp1 = await new Promise<{ closed: boolean; text: string }>(
        (resolve) => {
          let text = "";
          let drip: Timer | undefined;
          Bun.connect({
            hostname: "127.0.0.1",
            port: result.server.port ?? 0,
            socket: {
              close: () => {
                clearInterval(drip);
                resolve({ closed: true, text });
              },
              data: (_socket, chunk) => {
                text += chunk.toString();
              },
              open: (socket) => {
                socket.write(
                  `POST ${subscribePath} HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\nab`
                );
                drip = setInterval(() => socket.write("c"), 100);
              },
            },
          });
        }
      );
      expect(overHttp1.closed).toBe(true);
      expect(overHttp1.text).toStartWith("HTTP/1.1 408");
      expect(overHttp1.text.toLowerCase()).toContain("connection: close");
      expect(performance.now() - started).toBeLessThan(2000);
      const http2Status = await new Promise<number>((resolve, reject) => {
        const h2 = connect(origin);
        h2.on("error", reject);
        const stream = h2.request({
          ":method": "POST",
          ":path": subscribePath,
          "content-length": 100,
        });
        stream.on("error", reject);
        stream.write("ab");
        const drip = setInterval(() => stream.write("c"), 100);
        stream.on("response", (answer) => {
          clearInterval(drip);
          h2.destroy();
          resolve(Number(answer[":status"]));
        });
      });
      expect(http2Status).toBe(408);
      // A body declared at exactly a stranger's limit is held to the deadline too.
      const atLimit = await new Promise<string>((resolve) => {
        let text = "";
        Bun.connect({
          hostname: "127.0.0.1",
          port: result.server.port ?? 0,
          socket: {
            close: () => resolve(text),
            data: (_socket, chunk) => {
              text += chunk.toString();
            },
            open: (socket) => {
              socket.write(
                `POST ${subscribePath} HTTP/1.1\r\nhost: x\r\ncontent-length: ${64 * 1024}\r\n\r\nab`
              );
            },
          },
        });
      });
      expect(atLimit).toStartWith("HTTP/1.1 408");
      expect(
        await (
          await fetch(`${origin}${subscribePath}`, {
            body: "x".repeat(1000),
            method: "POST",
          })
        ).text()
      ).toBe("read 1000");
    } finally {
      await result.stop();
    }
  });

  test("a stranger's request waiting at the pace leaves the body budget, which the pace already bounds: a page password try waiting its turn leaves room for a subscriber", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: async (r, o) => { if (o?.context?.publicTarget) return new Response('<html><body><p data-slot=\"access-wrong\" hidden>wrong</p></body></html>', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }); return new Response('read ' + (await r.text()).length); } };",
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      pace: testPace(0, {}, { gapMs: 1500, waiting: 10 }, { forms: 1 }),
    });
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      const stored = await result.storage.pages.find(created.page.id);
      if (!stored) {
        throw new Error("no page");
      }
      const saved = await savePage(result.storage, created.page.id, {
        ...stored,
        access: { addresses: [], mode: "password", password: "correct horse" },
        layout: [],
      });
      if (!saved.ok) {
        throw new Error(saved.reason);
      }
      const origin = `http://127.0.0.1:${result.server.port}`;
      const attempt = () =>
        fetch(origin, {
          body: "password=nope",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin,
          },
          method: "POST",
        });
      // The first takes the check's one turn; the second waits a gap for the next.
      expect((await attempt()).status).toBe(403);
      const waiting = attempt();
      await Bun.sleep(300);
      const subscriber = await fetch(`${origin}${subscribePath}`, {
        body: "body",
        method: "POST",
      });
      expect(await subscriber.text()).toBe("read 4");
      expect((await waiting).status).toBe(403);
    } finally {
      await result.stop();
    }
  });

  test("a scanner's burst of not-founds, page and API, costs one render of the page's not-found, its stylesheet linked, and leaves the routes to the app", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "let renders = 0; export default { fetch: (r, o) => { renders += 1; const path = new URL(r.url).pathname; return new Response('<html><body>render ' + renders + ' of ' + path + ' inline ' + o?.inlineCss + '</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' }, status: path === '/sign-in' ? 200 : 404 }); } };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        const at = (path: string) =>
          fetch(`http://127.0.0.1:${server.port}${path}`);
        for (let i = 0; i < 200; i += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: one request at a time, as a scanner sends them
          const page = await at(`/.env.${i}`);
          expect(page.status).toBe(404);
          expect(page.headers.get("x-frame-options")).toBe("DENY");
          expect(await page.text()).toBe(
            "<html><body>render 1 of /history/0000-00 inline false</body></html>"
          );
          const api = await at(`/api/nope/${i}`);
          expect(api.status).toBe(404);
          expect(await api.text()).toBe("Not Found");
        }
        expect(await (await at("/sign-in")).text()).toBe(
          "<html><body>render 2 of /sign-in inline undefined</body></html>"
        );
      }
    );
  });

  test("a request that asks to be held open outlives Bun's idle timer, which closes a quiet request beside it, as test now needs, over HTTP/1.1 and HTTP/2", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    // The quiet requests wait until the idle timer closes them; the held ones answer once both are closed, or say the timer never fired.
    const dir = await serverBuild({
      "server/handler.js": `let closes = 0; let fired; const closed = new Promise((resolve) => { fired = resolve; });
        export default { fetch: async (r, o) => {
          if (new URL(r.url).pathname === "/api/heartbeat/quiet") {
            await Promise.race([new Promise((resolve) => r.signal.addEventListener("abort", resolve)), Bun.sleep(8000)]);
            closes += 1;
            if (closes === 2) fired();
            return new Response("late");
          }
          o.context.holdOpen(30);
          return new Response(await Promise.race([closed.then(() => "late"), Bun.sleep(8000).then(() => "the idle timer never fired")]));
        } };`,
    });
    // Bun's timer ticks every few seconds, so one second closes a quiet request within about five.
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir, {
      idleTimeoutSeconds: 1,
    });
    if (typeof result === "number") {
      throw new Error(`expected a server, got exit code ${result}`);
    }
    try {
      const origin = `http://127.0.0.1:${result.server.port}`;
      // Over HTTP/2 the timer belongs to the connection, so the held request still keeps it open.
      const [held, heldOverHttp2, quiet, quietOverHttp2] = await Promise.all([
        fetch(`${origin}/api/heartbeat/held`).then((response) =>
          response.text()
        ),
        overHttp2(origin, "/api/heartbeat/held").then((answer) => answer.body),
        fetch(`${origin}/api/heartbeat/quiet`).then(
          (response) => response.text(),
          () => "closed"
        ),
        overHttp2(origin, "/api/heartbeat/quiet").then(
          (answer) => answer.body || "closed",
          () => "closed"
        ),
      ]);
      expect({ held, heldOverHttp2, quiet, quietOverHttp2 }).toEqual({
        held: "late",
        heldOverHttp2: "late",
        quiet: "closed",
        quietOverHttp2: "closed",
      });
    } finally {
      await result.stop();
    }
  }, 10_000);

  test("a database the onboarding database screen opens through the entry's opener serves every later request", async () => {
    const dataDir = await clientBuild({});
    const dir = await serverBuild({
      "server/handler.js": `export default { fetch: async (r, o) => {
        if (new URL(r.url).pathname === "/onboarding/database") {
          const opened = await o.context.opener.open({ backend: "sqlite", file: o.context.boot.dataDir + "/raaqeb.sqlite" });
          return new Response(String(opened.ok));
        }
        return new Response(String(o?.context?.storage?.backend));
      } };`,
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        expect(await (await fetch(`${origin}/`)).text()).toBe("undefined");
        expect(
          await (await fetch(`${origin}/onboarding/database`)).text()
        ).toBe("true");
        expect(await (await fetch(`${origin}/`)).text()).toBe("sqlite");
      }
    );
  });

  test("every request carries the scheduler once a database is open, and none during onboarding", async () => {
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: (r, o) => new Response(String(o?.context?.scheduler?.lastTickAt() !== undefined)) };",
    });
    const withDatabase = await clientBuild({ "raaqeb.sqlite": "" });
    await withServer(
      ["--port", "0", "--data-dir", withDatabase],
      {},
      dir,
      async (server) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(await response.text()).toBe("true");
      }
    );
    const onboarding = await clientBuild({});
    await withServer(
      ["--port", "0", "--data-dir", onboarding],
      {},
      dir,
      async (server) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(await response.text()).toBe("false");
      }
    );
  });

  test("a database opened through the entry's opener starts the scheduler for every later request", async () => {
    const dataDir = await clientBuild({});
    const dir = await serverBuild({
      "server/handler.js": `export default { fetch: async (r, o) => {
        if (new URL(r.url).pathname === "/onboarding/database") {
          const opened = await o.context.opener.open({ backend: "sqlite", file: o.context.boot.dataDir + "/raaqeb.sqlite" });
          return new Response(String(opened.ok));
        }
        return new Response(String(o?.context?.scheduler?.lastTickAt() !== undefined));
      } };`,
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        expect(await (await fetch(`${origin}/`)).text()).toBe("false");
        expect(
          await (await fetch(`${origin}/onboarding/database`)).text()
        ).toBe("true");
        expect(await (await fetch(`${origin}/`)).text()).toBe("true");
      }
    );
  });

  test("health exits 0 when the server answers 200 at the boot address, and 1 when nothing listens", async () => {
    const dataDir = await clientBuild({});
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      await build(),
      async (server) => {
        expect(
          await main(["health", "--port", String(server.port)], {}, "")
        ).toBe(0);
      }
    );
    const idle = Bun.serve({ fetch: () => new Response("x"), port: 0 });
    const freePort = idle.port;
    await idle.stop(true);
    expect(await main(["health", "--port", String(freePort)], {}, "")).toBe(1);
  });

  test("--version prints the version and --help the commands, both exit 0 and touch no data directory", async () => {
    const dataDir = `${await clientBuild({})}/untouched`;
    for (const flag of ["--version", "--help"]) {
      const out: string[] = [];
      const terminal: Terminal = {
        askHidden: () => Promise.resolve(""),
        err: (line) => out.push(`err: ${line}`),
        interactive: false,
        out: (line) => out.push(line),
      };
      // biome-ignore lint/performance/noAwaitInLoops: each flag is its own run
      const code = await main([flag], { RAAQEB_DATA_DIR: dataDir }, "", {
        terminal,
      });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain(currentVersion);
    }
    expect(await Bun.file(dataDir).exists()).toBe(false);
  });

  test("health exits 1 on a 503", async () => {
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: () => new Response('{}', { status: 503 }) };",
    });
    const dataDir = await clientBuild({});
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        expect(
          await main(["health", "--port", String(server.port)], {}, "")
        ).toBe(1);
      }
    );
  });

  test("health needs no build and never creates the data directory", async () => {
    const dir = `${await clientBuild({})}/never`;
    expect(
      await main(["health", "--port", "1", "--data-dir", dir], {}, "/nowhere")
    ).toBe(1);
    expect(await Bun.file(`${dir}/config.json`).exists()).toBe(false);
  });

  test("every request carries the origin the client used, resolved behind the trusted proxies", async () => {
    const dataDir = await clientBuild({});
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: (r) => new Response(String(r.headers.get('x-raaqeb-request-origin'))) };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const forwarded = await fetch(`${origin}/`, {
          headers: {
            "x-forwarded-host": "status.example.test",
            "x-forwarded-proto": "https",
            "x-raaqeb-request-origin": "http://forged.example",
          },
        });
        expect(await forwarded.text()).toBe("https://status.example.test");
        const plain = await fetch(`${origin}/`, {
          headers: { "x-raaqeb-request-origin": "http://forged.example" },
        });
        expect(await plain.text()).toBe(origin);
        // A forward that is not a scheme leaves no origin at all, never the client's.
        const forged = await fetch(`${origin}/`, {
          headers: {
            "x-forwarded-proto": "javascript",
            "x-raaqeb-request-origin": "http://forged.example",
          },
        });
        expect(await forged.text()).toBe("null");
      }
    );
  });

  test("every request carries its socket peer and whether the trusted proxies it was resolved with hold it", async () => {
    const dataDir = await clientBuild({});
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: (r, o) => Response.json(o.context.peer()) };",
    });
    const peerOf = async (args: string[]): Promise<unknown> => {
      let peer: unknown;
      await withServer(
        ["--port", "0", "--data-dir", dataDir, ...args],
        {},
        dir,
        async (server) => {
          peer = await (
            await fetch(`http://127.0.0.1:${server.port}/`, {
              headers: { "x-forwarded-for": "198.51.100.1" },
            })
          ).json();
        }
      );
      return peer;
    };
    expect(await peerOf([])).toEqual({ address: "127.0.0.1", trusted: false });
    expect(await peerOf(["--trusted-proxies", "127.0.0.0/8"])).toEqual({
      address: "127.0.0.1",
      trusted: true,
    });
  });

  test("every request carries the client address the entry resolved, replacing any header the client sent", async () => {
    const dataDir = await clientBuild({});
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: (r) => new Response(String(r.headers.get('x-raaqeb-client-address'))) };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        const forged = await fetch(`http://127.0.0.1:${server.port}/`, {
          headers: {
            "x-forwarded-for": "198.51.100.1",
            "x-raaqeb-client-address": "198.51.100.2",
          },
        });
        // No trusted proxy: the peer is the client, whatever the headers say.
        expect(await forged.text()).toBe("127.0.0.1");
      }
    );
    await withServer(
      ["--port", "0", "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
      {},
      dir,
      async (server) => {
        const forwarded = await fetch(`http://127.0.0.1:${server.port}/`, {
          headers: { "x-forwarded-for": "198.51.100.1, 127.0.0.1" },
        });
        expect(await forwarded.text()).toBe("198.51.100.1");
      }
    );
  });

  test("every request carries the BETTER_AUTH_SECRETS override as the auth boot context", async () => {
    const dataDir = await clientBuild({});
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: (r, o) => new Response(String(o?.context?.boot?.betterAuthSecrets?.length)) };",
    });
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      { BETTER_AUTH_SECRETS: "1:secret" },
      dir,
      async (server) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(await response.text()).toBe("8");
      }
    );
  });

  test("serve with a database it cannot reach exits 1", async () => {
    const dataDir = await clientBuild({});
    expect(
      await main(
        ["--port", "0", "--data-dir", dataDir],
        { DATABASE_URL: "postgres://raaqeb:pw@127.0.0.1:1/raaqeb" },
        await build(),
        { connectWindowMs: 200 }
      )
    ).toBe(1);
  });

  test("serve answers the client build before the handler", async () => {
    const dataDir = await clientBuild({});
    await withServer(
      ["serve", "--port", "0", "--data-dir", dataDir],
      {},
      await build(),
      async (server) => {
        const response = await fetch(
          `http://127.0.0.1:${server.port}/assets/app-Bx1c9d2e.js`
        );
        expect(await response.text()).toBe("console.log(1);");
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable"
        );
      }
    );
  });

  test("serve reads the variables", async () => {
    const dataDir = await clientBuild({});
    await withServer(
      [],
      { RAAQEB_DATA_DIR: dataDir, RAAQEB_HOST: "127.0.0.1", RAAQEB_PORT: "0" },
      await build(),
      async (server) => {
        expect(server.port).toBeGreaterThan(0);
        expect(await Bun.file(`${dataDir}/config.json`).exists()).toBe(true);
      }
    );
  });

  test("serve on a port already in use exits 1", async () => {
    const dataDir = await clientBuild({});
    const dir = await build();
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        expect(
          await main(
            ["--port", String(server.port), "--data-dir", dataDir],
            {},
            dir
          )
        ).toBe(1);
      }
    );
  });

  test("a second serve on a busy port exits 1 before it opens or migrates the database", async () => {
    const dir = await build();
    const mine = await clientBuild({});
    const theirs = await clientBuild({ "raaqeb.sqlite": "" });
    const first = Bun.spawn(
      [process.execPath, "-e", serveScript, mine, dir, "0"],
      { stderr: "ignore", stdout: "pipe" }
    );
    try {
      const port = await portOf(first.stdout);
      const second = Bun.spawn(
        [process.execPath, "-e", serveScript, theirs, dir, port],
        { stderr: "pipe", stdout: "ignore" }
      );
      const [lines, code] = await Promise.all([
        new Response(second.stderr).text(),
        second.exited,
      ]);
      expect(code).toBe(1);
      // Only the refusal: no snapshot, migration or scheduler line before or after it.
      expect(lines.trim().split("\n")).toEqual([
        "raaqeb: cannot listen: RAAQEB_HOST and RAAQEB_PORT name an address that is not available",
      ]);
      // The database it was pointed at is as it was written.
      expect(Bun.file(`${theirs}/raaqeb.sqlite`).size).toBe(0);
    } finally {
      first.kill();
      await first.exited;
    }
  });

  test("serve without a build exits 1 before touching the database", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    expect(
      await main(
        ["--port", "0", "--data-dir", dataDir],
        {},
        "/nonexistent/raaqeb/dist"
      )
    ).toBe(1);
    // Nothing was migrated: the file is as empty as it was written.
    expect(Bun.file(`${dataDir}/raaqeb.sqlite`).size).toBe(0);
  });

  test("serve with a boot setting it cannot use exits 1", async () => {
    const dataDir = await clientBuild({});
    expect(
      await main(
        ["--port", "not a port", "--data-dir", dataDir],
        {},
        await build()
      )
    ).toBe(1);
  });

  test("reset-password runs beside a live server over the same database and prints a link the server honours", async () => {
    const dataDir = await clientBuild({});
    const dir = await build();
    const booted = await resolveBootSettings({ RAAQEB_DATA_DIR: dataDir }, {});
    if (!booted.ok) {
      throw new Error(booted.message);
    }
    // The install, as onboarding leaves it: a database in the data directory with the account and the public address.
    const located = await locateDatabase({
      ...booted.settings,
      databaseUrl: undefined,
    });
    const seeded = await openStorage(
      located ?? { backend: "sqlite", file: `${dataDir}/raaqeb.sqlite` }
    );
    if (!seeded.ok) {
      throw new Error(seeded.message);
    }
    await seeded.storage.settings.set(publicAddress, "http://raaqeb.test");
    const seededAuth = await authFor(seeded.storage, booted.settings);
    await seededAuth.api.signUpEmail({
      body: {
        email: "operator@example.com",
        name: operatorName,
        password: "correct horse battery",
      },
    });
    await seeded.storage.close();
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        expect(server.port).toBeGreaterThan(0);
        const lines: string[] = [];
        const terminal: Terminal = {
          askHidden: () => Promise.resolve(""),
          err: (line) => lines.push(line),
          interactive: false,
          out: (line) => lines.push(line),
        };
        expect(
          await main(["reset-password", "--data-dir", dataDir], {}, dir, {
            terminal,
          })
        ).toBe(0);
        const link = lines.find((l) => l.includes("/reset-password?token="));
        expect(link).toBeDefined();
        const token = new URL(link ?? "").searchParams.get("token") ?? "";
        const running = await openStorage({
          backend: "sqlite",
          file: `${dataDir}/raaqeb.sqlite`,
        });
        if (!running.ok) {
          throw new Error(running.message);
        }
        try {
          const auth = await authFor(running.storage, booted.settings);
          const reset = await auth.api.resetPassword({
            body: { newPassword: "a brand new password", token },
          });
          expect(reset.status).toBe(true);
        } finally {
          await running.storage.close();
        }
      }
    );
  });

  test("serve migrates with the migrations its build carries, not the source tree's", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await bareBuild();
    await carryMigrations(dir, 1);
    const [first] = await localMigrations("sqlite");
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir);
    if (typeof result !== "number") {
      await result.stop();
    }
    // One migration makes none of the later tables, so the check after the run refuses the start.
    expect(result).toBe(1);
    expect(
      await runSql(
        { backend: "sqlite", file: `${dataDir}/raaqeb.sqlite` },
        "SELECT name FROM __drizzle_migrations ORDER BY id",
        []
      )
    ).toEqual([{ name: first }]);
  });

  test("the onboarding database screen opens with the migrations the build carries", async () => {
    const dataDir = await clientBuild({});
    const dir = await clientBuild({
      "server/handler.js": `export default { fetch: async (r, o) => {
        const opened = await o.context.opener.open({ backend: "sqlite", file: o.context.boot.dataDir + "/raaqeb.sqlite" });
        return new Response(String(opened.ok));
      } };`,
    });
    await carryMigrations(dir, 1);
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        expect(
          await (await fetch(`${origin}/onboarding/database`)).text()
        ).toBe("false");
      }
    );
  });

  test("reset-password opens the database with the migrations the build carries", async () => {
    const dataDir = await clientBuild({});
    const location = {
      backend: "sqlite" as const,
      file: `${dataDir}/raaqeb.sqlite`,
    };
    const opened = await openStorage(location);
    if (!opened.ok) {
      throw new Error(opened.message);
    }
    await opened.storage.close();
    const dir = await bareBuild();
    await carryMigrations(dir, 1);
    const lines: string[] = [];
    const terminal: Terminal = {
      askHidden: () => Promise.resolve(""),
      err: (line) => lines.push(line),
      interactive: false,
      out: () => undefined,
    };
    expect(
      await main(
        ["reset-password", "--data-dir", dataDir],
        { RAAQEB_SECRET_KEY: generateInstallKey() },
        dir,
        { terminal }
      )
    ).toBe(1);
    expect(lines.join("\n")).toContain("newer than this raaqeb knows");
  });

  test("reset-password --interactive without a terminal exits 2", async () => {
    const dataDir = await clientBuild({});
    const terminal: Terminal = {
      askHidden: () => Promise.resolve(""),
      err: () => undefined,
      interactive: false,
      out: () => undefined,
    };
    expect(
      await main(
        ["reset-password", "--interactive", "--data-dir", dataDir],
        {},
        await build(),
        { terminal }
      )
    ).toBe(2);
  });

  test("set-address runs beside a live server over the same database, stores the address and moves the change counter the server reads", async () => {
    const dataDir = await clientBuild({});
    const dir = await build();
    const file = `${dataDir}/raaqeb.sqlite`;
    // The install left behind by an earlier version: an address the browser is never at.
    const seeded = await openStorage({ backend: "sqlite", file });
    if (!seeded.ok) {
      throw new Error(seeded.message);
    }
    await seeded.storage.settings.set(
      publicAddress,
      "http://status.example.test"
    );
    const before = await seeded.storage.changeCounter();
    await seeded.storage.close();
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async () => {
        const lines: string[] = [];
        const terminal: Terminal = {
          askHidden: () => Promise.resolve(""),
          err: (line) => lines.push(line),
          interactive: false,
          out: (line) => lines.push(line),
        };
        expect(
          await main(
            [
              "set-address",
              "https://status.example.test",
              "--data-dir",
              dataDir,
            ],
            {},
            dir,
            { terminal }
          )
        ).toBe(0);
        expect(lines.join("\n")).toContain("https://status.example.test");
        const running = await openStorage({ backend: "sqlite", file });
        if (!running.ok) {
          throw new Error(running.message);
        }
        try {
          expect(await running.storage.settings.get(publicAddress)).toBe(
            "https://status.example.test"
          );
          expect(await running.storage.changeCounter()).toBe(before + 1);
        } finally {
          await running.storage.close();
        }
      }
    );
  });

  test("set-address before onboarding chose a database exits 1 and creates none", async () => {
    const dataDir = await clientBuild({});
    const lines: string[] = [];
    const terminal: Terminal = {
      askHidden: () => Promise.resolve(""),
      err: (line) => lines.push(line),
      interactive: false,
      out: () => undefined,
    };
    expect(
      await main(
        ["set-address", "https://status.example.test", "--data-dir", dataDir],
        {},
        await build(),
        { terminal }
      )
    ).toBe(1);
    expect(lines.join("\n")).toContain("onboarding");
    expect(await Bun.file(`${dataDir}/raaqeb.sqlite`).exists()).toBe(false);
  });

  test("reset-password and set-address where no install lives exit 1 and create no data directory or key", async () => {
    const parent = await clientBuild({});
    const dataDir = `${parent}/data`;
    const lines: string[] = [];
    const terminal: Terminal = {
      askHidden: () => Promise.resolve(""),
      err: (line) => lines.push(line),
      interactive: false,
      out: () => undefined,
    };
    const dir = await build();
    const refusedWith = async (command: string[]) => {
      lines.length = 0;
      expect(
        await main([...command, "--data-dir", dataDir], {}, dir, { terminal })
      ).toBe(1);
      expect(lines.join("\n")).toContain("there is no install here");
      expect(
        (
          await Array.fromAsync(
            new Bun.Glob("*").scan({ cwd: parent, onlyFiles: false })
          )
        ).length
      ).toBe(0);
    };
    await refusedWith(["reset-password"]);
    await refusedWith(["set-address", "https://status.example.test"]);
  });

  test("a command run with a key in the environment and no database creates no data directory either", async () => {
    const parent = await clientBuild({});
    const lines: string[] = [];
    const terminal: Terminal = {
      askHidden: () => Promise.resolve(""),
      err: (line) => lines.push(line),
      interactive: false,
      out: () => undefined,
    };
    expect(
      await main(
        ["reset-password", "--data-dir", `${parent}/data`],
        { RAAQEB_SECRET_KEY: generateInstallKey() },
        await build(),
        { terminal }
      )
    ).toBe(1);
    expect(lines.join("\n")).toContain("no database yet");
    expect(
      (
        await Array.fromAsync(
          new Bun.Glob("*").scan({ cwd: parent, onlyFiles: false })
        )
      ).length
    ).toBe(0);
  });

  test("set-address with an address that is not an origin exits 2", async () => {
    const dataDir = await clientBuild({});
    expect(
      await main(
        ["set-address", "https://status.example.test/", "--data-dir", dataDir],
        {},
        await build()
      )
    ).toBe(2);
  });

  test("a command line the entry does not accept exits 2", async () => {
    expect(await main(["export"], {}, await build())).toBe(2);
    expect(await main(["--verbose"], {}, await build())).toBe(2);
  });
});

describe("the entry never prints a boot setting's value", () => {
  async function runEntry(
    env: Record<string, string>
  ): Promise<{ code: number; output: string }> {
    const child = Bun.spawn(["bun", "src/server.ts"], {
      cwd: `${import.meta.dir}/..`,
      env: { PATH: process.env.PATH ?? "", ...env },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, output: stdout + stderr };
  }

  test("a refused port is named with its length only", async () => {
    const dataDir = await clientBuild({});
    const marker = "MARKER_PORT_VALUE";
    const { code, output } = await runEntry({
      BETTER_AUTH_SECRETS: "MARKER_AUTH",
      DATABASE_URL: "MARKER_URL",
      RAAQEB_DATA_DIR: dataDir,
      RAAQEB_HOST: "MARKER_HOST",
      RAAQEB_PORT: marker,
      RAAQEB_SECRET_KEY: "MARKER_KEY",
      RAAQEB_TRUSTED_PROXIES: "MARKER_PROXY",
    });
    expect(code).toBe(1);
    expect(output).toContain("RAAQEB_PORT");
    expect(output).toContain(String(marker.length));
    expect(output).not.toContain("MARKER");
    expect(output).not.toContain(dataDir);
  });

  test("a generated install key is announced, and the address is never printed", async () => {
    const dataDir = await clientBuild({});
    // Holding the port makes the entry exit 1 whether or not a real dist/ exists.
    const held = Bun.serve({
      fetch: () => new Response(""),
      hostname: "127.0.0.1",
      port: 0,
      reusePort: false,
    });
    try {
      const { code, output } = await runEntry({
        RAAQEB_DATA_DIR: dataDir,
        RAAQEB_HOST: "127.0.0.1",
        RAAQEB_PORT: String(held.port),
      });
      expect(code).toBe(1);
      expect(output).toContain("install key generated");
      expect(output).not.toContain(String(held.port));
      expect(output).not.toContain(dataDir);
    } finally {
      await held.stop(true);
    }
  });

  test("onboarding says no database was chosen yet", async () => {
    const dataDir = await clientBuild({});
    const written: string[] = [];
    const stdout = spyOn(process.stdout, "write").mockImplementation(
      (chunk) => {
        written.push(String(chunk));
        return true;
      }
    );
    try {
      await withServer(
        ["--port", "0", "--data-dir", dataDir],
        {},
        await build(),
        () => Promise.resolve()
      );
    } finally {
      stdout.mockRestore();
    }
    expect(written.join("")).toContain("no database yet");
  });

  test("a refused install key is named with its length only", async () => {
    const dataDir = await clientBuild({});
    const { code, output } = await runEntry({
      RAAQEB_DATA_DIR: dataDir,
      RAAQEB_SECRET_KEY: "MARKER_KEY_VALUE",
    });
    expect(code).toBe(1);
    expect(output).toContain("RAAQEB_SECRET_KEY");
    expect(output).toContain("16");
    expect(output).not.toContain("MARKER");
  });
});

/** Starts `serve` over a data directory holding an empty SQLite file, so the write-ahead log exists, and answers once it listens. */
async function servingOverSqlite(command: string[]) {
  if (
    !(await Bun.file(`${import.meta.dir}/../dist/server/handler.js`).exists())
  ) {
    throw new Error("this test serves the built app: run `bun run build`");
  }
  const dataDir = await clientBuild({});
  await Bun.write(`${dataDir}/raaqeb.sqlite`, "");
  const child = Bun.spawn(command, {
    cwd: `${import.meta.dir}/..`,
    env: {
      PATH: process.env.PATH ?? "",
      RAAQEB_DATA_DIR: dataDir,
      RAAQEB_PORT: "0",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  let output = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    output += decoder.decode(chunk);
    if (output.includes("listening")) {
      break;
    }
  }
  // The entry adds its signal listeners just after main logs "listening"; a signal before them is the default kill.
  await Bun.sleep(200);
  // A fresh BunFile each time: one BunFile keeps the answer it read first.
  const wal = () => Bun.file(`${dataDir}/raaqeb.sqlite-wal`).exists();
  return { child, output, wal };
}

/** What a test that starts the real server may take: it waits on the child's output, and a loaded machine has stretched a start to half a minute. */
const serverStartLimitMs = 60_000;

describe("a stop by signal", () => {
  // These start the real entry as a child process and wait on its output and exit, never on a clock; the limit only ends a hang, and a start that a loaded machine stretches to half a minute must not read as one.
  test.each(["SIGTERM", "SIGINT"] as const)(
    "%s stops the server cleanly, the write-ahead log checkpointed into the SQLite file",
    async (signal) => {
      const { child, output, wal } = await servingOverSqlite([
        "bun",
        "src/server.ts",
      ]);
      expect(output).toContain("listening");
      expect(await wal()).toBe(true);
      child.kill(signal);
      expect(await child.exited).toBe(0);
      expect(await wal()).toBe(false);
    },
    serverStartLimitMs
  );

  test("SIGHUP stops the server on Windows alone, where it means the console window closed; elsewhere SIGTERM and SIGINT", () => {
    expect(stopSignals("linux")).toEqual(["SIGTERM", "SIGINT"]);
    expect(stopSignals("darwin")).toEqual(["SIGTERM", "SIGINT"]);
    expect(stopSignals("win32")).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
  });

  test(
    "a server started under nohup, with SIGHUP ignored, keeps serving when its terminal hangs up",
    async () => {
      const { child, output } = await servingOverSqlite([
        "sh",
        "-c",
        "trap '' HUP; exec bun src/server.ts",
      ]);
      expect(output).toContain("listening");
      child.kill("SIGHUP");
      await Bun.sleep(500);
      expect(child.exitCode).toBeNull();
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
    },
    serverStartLimitMs
  );
});

describe("the security headers of an HTML response", () => {
  /** A handler answering HTML everywhere, its body the nonce its render was handed, saying it drew a status page at the view and a subscription's page as those routes do, public at a status page's view, a page image under its own sandbox policy, the cover as HTML under that policy, and the summary as JSON. */
  const handler = [
    "export default { fetch: (r, o) => {",
    "const path = new URL(r.url).pathname;",
    "if (path.endsWith('.json')) return Response.json({}, { headers: { 'cache-control': 'public, max-age=0, must-revalidate' } });",
    "if (path === '/api/pages/some-id/cover') return new Response('<script></script>', { headers: { 'content-type': 'text/html', 'content-security-policy': \"default-src 'none'; style-src 'unsafe-inline'; sandbox\" } });",
    "if (path.startsWith('/api/pages/')) return new Response('png', { headers: { 'content-type': 'image/png', 'content-security-policy': \"default-src 'none'; style-src 'unsafe-inline'; sandbox\", 'x-content-type-options': 'nosniff' } });",
    "const page = path === '/' || path.startsWith('/subscriptions/') ? { 'x-raaqeb-status-page': '1' } : {};",
    "return new Response('<!doctype html>' + o.context.nonce, { headers: { ...page, 'content-type': 'text/html; charset=utf-8', 'cache-control': path === '/' ? 'public, max-age=0, must-revalidate' : 'no-store' } });",
    "} };",
  ].join("\n");

  /** A server over a database holding one status page, whose overview is `/`, the public address set to `address`. */
  async function withPage<T>(
    address: string | undefined,
    body: (
      at: (path: string) => Promise<Response>,
      storage: Storage
    ) => Promise<T>
  ): Promise<T> {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({ "server/handler.js": handler });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir);
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    try {
      const created = await createPage(result.storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(result.storage, created.page.id);
      if (address) {
        await result.storage.settings.set(publicAddress, address);
        await result.storage.bump();
      }
      const { storage } = result;
      return await body(
        (path) => fetch(`http://127.0.0.1:${result.server.port}${path}`),
        storage
      );
    } finally {
      await result.stop();
    }
  }

  /** An admin page, the sign-in page and an onboarding page; `/` is the status page's overview. */
  const notViews = ["/admin/monitors", "/sign-in", "/onboarding/language"];

  /** The header's value on each path, null where it is absent. */
  const valuesOf = (
    at: (path: string) => Promise<Response>,
    name: string,
    paths: readonly string[]
  ) =>
    Promise.all(paths.map(async (path) => (await at(path)).headers.get(name)));

  test("an admin page refuses every frame by Content-Security-Policy frame-ancestors, and a status page's view refuses none", async () => {
    await withPage(undefined, async (at) => {
      const policies = await valuesOf(at, "content-security-policy", [
        ...notViews,
        "/",
      ]);
      expect(
        policies.map((policy) => policy?.includes("frame-ancestors 'none'"))
      ).toEqual([true, true, true, false]);
      expect(policies[3]).not.toContain("frame-ancestors");
    });
  });

  /** The directives of the answer's first policy, by name, and the nonce its body says the render was handed. */
  async function policyOf(
    response: Response
  ): Promise<{ directives: Map<string, string>; nonce: string }> {
    const [first = ""] = (
      response.headers.get("content-security-policy") ?? ""
    ).split(",");
    const directives = new Map(
      first
        .split(";")
        .map((each) => each.trim())
        .filter((each) => each !== "")
        .map((each) => {
          const [name = "", ...values] = each.split(" ");
          return [name, values.join(" ")] as const;
        })
    );
    const nonce = (await response.text()).replace("<!doctype html>", "");
    return { directives, nonce };
  }

  test("a rendered page runs scripts from its own origin and the inline ones its render wrote, named by that render's nonce, and never evaluates a string", async () => {
    await withPage(undefined, async (at) => {
      for (const path of [...notViews, "/"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one page at a time
        const { directives, nonce } = await policyOf(await at(path));
        expect(nonce, path).not.toBe("");
        expect(directives.get("script-src"), path).toBe(
          `'self' 'nonce-${nonce}'`
        );
      }
    });
  });

  test("a rendered page's style elements need its nonce, while a style attribute applies", async () => {
    await withPage(undefined, async (at) => {
      for (const path of [...notViews, "/"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one page at a time
        const { directives, nonce } = await policyOf(await at(path));
        expect(
          directives.get("style-src")?.split(" ").slice(0, 2),
          path
        ).toEqual(["'self'", `'nonce-${nonce}'`]);
        expect(directives.get("style-src"), path).not.toContain(
          "'unsafe-inline'"
        );
        expect(directives.get("style-src-attr"), path).toBe("'unsafe-inline'");
      }
    });
  });

  test("a rendered page loads everything else from its own origin, embeds no plugin, takes no base element and posts its forms to its own origin alone", async () => {
    await withPage(undefined, async (at) => {
      for (const path of [...notViews, "/"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one page at a time
        const { directives } = await policyOf(await at(path));
        expect(
          ["default-src", "object-src", "base-uri", "form-action"].map((name) =>
            directives.get(name)
          ),
          path
        ).toEqual(["'self'", "'none'", "'none'", "'self'"]);
      }
    });
  });

  test("each render of a page outside the memo has a nonce of its own", async () => {
    await withPage(undefined, async (at) => {
      const first = await policyOf(await at("/reset-password?token=t"));
      const second = await policyOf(await at("/reset-password?token=t"));
      expect(first.nonce).not.toBe(second.nonce);
      expect(second.directives.get("script-src")).toBe(
        `'self' 'nonce-${second.nonce}'`
      );
    });
  });

  test("a status page's view from the memo, and a held ETag's 304, carry the nonce of the render that wrote the body", async () => {
    await withPage(undefined, async (at) => {
      const first = await policyOf(await at("/"));
      const stored = await at("/");
      const held = await fetch(stored.url, {
        headers: { "if-none-match": stored.headers.get("etag") ?? "" },
      });
      expect(held.status).toBe(304);
      const kept = await policyOf(stored);
      expect(kept.nonce).toBe(first.nonce);
      for (const response of [stored, held]) {
        expect(response.headers.get("content-security-policy")).toContain(
          `'nonce-${first.nonce}'`
        );
      }
    });
  });

  test("a render that says it drew a status page lets the page's custom CSS load fonts, images and stylesheets from any https origin or a data URL; every other render loads them from its own origin alone, whatever its address", async () => {
    await withPage(undefined, async (at) => {
      // A subscription's own page is drawn in its status page's frame too.
      for (const path of ["/", "/subscriptions/some-token"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one page at a time
        const { directives, nonce } = await policyOf(await at(path));
        expect(
          ["img-src", "font-src", "style-src"].map((name) =>
            directives.get(name)
          ),
          path
        ).toEqual([
          "'self' https: data:",
          "'self' https: data:",
          `'self' 'nonce-${nonce}' https:`,
        ]);
      }
      // A route the app does not know yet, such as a second step's own page, says nothing and is held as an operator's page is.
      for (const path of [
        "/admin/monitors",
        "/sign-in",
        "/reset-password?token=t",
        "/onboarding/language",
        "/two-factor",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: one page at a time
        const { directives, nonce } = await policyOf(await at(path));
        expect(
          ["img-src", "font-src", "style-src"].map((name) =>
            directives.get(name)
          ),
          path
        ).toEqual([undefined, undefined, `'self' 'nonce-${nonce}'`]);
      }
    });
  });

  test("the header a status page's render carries to the entry never reaches the browser", async () => {
    await withPage(undefined, async (at) => {
      const stored = await at("/");
      const held = await fetch(stored.url, {
        headers: { "if-none-match": stored.headers.get("etag") ?? "" },
      });
      const answers = [
        await at("/"),
        stored,
        held,
        await at("/subscriptions/some-token"),
      ];
      expect(
        answers.map((response) => response.headers.has(statusPageHeader))
      ).toEqual([false, false, false, false]);
    });
  });

  test("an admin page refuses every frame by X-Frame-Options, and a status page's view may be framed", async () => {
    await withPage(undefined, async (at) => {
      expect(await valuesOf(at, "x-frame-options", [...notViews, "/"])).toEqual(
        ["DENY", "DENY", "DENY", null]
      );
    });
  });

  test("an admin page and a status page's view are both nosniff", async () => {
    await withPage(undefined, async (at) => {
      expect(
        await valuesOf(at, "x-content-type-options", [...notViews, "/"])
      ).toEqual(["nosniff", "nosniff", "nosniff", "nosniff"]);
    });
  });

  test("an admin page and a status page's view both send the origin alone to another site", async () => {
    await withPage(undefined, async (at) => {
      expect(await valuesOf(at, "referrer-policy", [...notViews, "/"])).toEqual(
        [...notViews, "/"].map(() => "strict-origin-when-cross-origin")
      );
    });
  });

  test("HSTS is sent only when the stored public address is https", async () => {
    const hsts = (address: string | undefined) =>
      withPage(address, (at) =>
        valuesOf(at, "strict-transport-security", ["/admin/monitors", "/"])
      );
    expect(
      await Promise.all([
        hsts(undefined),
        hsts("http://status.example.test"),
        hsts("https://status.example.test"),
      ])
    ).toEqual([
      [null, null],
      [null, null],
      ["max-age=31536000", "max-age=31536000"],
    ]);
  });

  test("an admin page takes the address the memo read with the change counter, not one read per request: an address stored without moving it counts once it moves", async () => {
    await withPage(undefined, async (at, storage) => {
      const hsts = async () =>
        (await at("/admin/monitors")).headers.get("strict-transport-security");
      expect(await hsts()).toBe(null);
      await storage.settings.set(publicAddress, "https://status.example.test");
      expect(await hsts()).toBe(null);
      await storage.bump();
      expect(await hsts()).toBe("max-age=31536000");
    });
  });

  test("an admin page gets HSTS once onboarding stores an https public address", async () => {
    const dataDir = await clientBuild({});
    const booted = await resolveBootSettings({}, { RAAQEB_DATA_DIR: dataDir });
    if (!booted.ok) {
      throw new Error(booted.message);
    }
    const boot = booted.settings;
    await withPage(undefined, async (at, storage) => {
      const hsts = async () =>
        (await at("/admin/monitors")).headers.get("strict-transport-security");
      // Before onboarding there is no address, so no HSTS.
      expect(await hsts()).toBe(null);
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: "https://status.example.test",
        },
        { boot, opener: databaseOpener(() => undefined), storage },
        new Headers({ origin: "https://status.example.test" })
      );
      expect(created.ok).toBe(true);
      expect(await hsts()).toBe("max-age=31536000");
    });
  });

  test("a status page's view answered from the memo keeps the headers, a held ETag's 304 too", async () => {
    await withPage("https://status.example.test", async (at) => {
      const first = await at("/");
      const stored = await at("/");
      const held = await fetch(stored.url, {
        headers: { "if-none-match": stored.headers.get("etag") ?? "" },
      });
      expect(held.status).toBe(304);
      for (const response of [first, stored, held]) {
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("strict-transport-security")).toBe(
          "max-age=31536000"
        );
        expect(response.headers.has("x-frame-options")).toBe(false);
      }
    });
  });

  test("a response that is not HTML keeps the headers it came with: a page image its sandbox policy, the summary none of these", async () => {
    await withPage("https://status.example.test", async (at) => {
      const image = await at("/api/pages/some-id/logo");
      expect(image.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      );
      expect(image.headers.has("x-frame-options")).toBe(false);
      expect(image.headers.has("strict-transport-security")).toBe(false);
      const summary = await at("/api/v2/summary.json");
      for (const name of [
        "content-security-policy",
        "x-frame-options",
        "x-content-type-options",
        "referrer-policy",
        "strict-transport-security",
      ]) {
        expect(summary.headers.has(name)).toBe(false);
      }
    });
  });

  test("an HTML response that carries its own policy keeps it, the frame refusal added beside it", async () => {
    await withPage(undefined, async (at) => {
      const html = await at("/api/pages/some-id/cover");
      expect(html.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox, frame-ancestors 'none'"
      );
    });
  });
});

describe("the trusted proxies saved on the general page", () => {
  /** A server over a fresh SQLite file whose handler answers the client address and origin the entry resolved. */
  async function withEcho(
    args: string[],
    body: (
      seen: (method?: string) => Promise<unknown>,
      storage: Storage,
      origin: string
    ) => Promise<void>
  ): Promise<void> {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: (r) => Response.json([r.headers.get('x-raaqeb-client-address'), r.headers.get('x-raaqeb-request-origin')]) };",
    });
    const result = await main(
      ["--port", "0", "--data-dir", dataDir, ...args],
      {},
      dir
    );
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    const origin = `http://127.0.0.1:${result.server.port}`;
    const seen = async (method = "GET") =>
      await (
        await fetch(`${origin}/sign-out?x=1`, {
          headers: {
            "x-forwarded-for": "203.0.113.9",
            "x-forwarded-host": "status.example.test",
            "x-forwarded-proto": "https",
          },
          method,
        })
      ).json();
    try {
      await body(seen, result.storage, origin);
    } finally {
      await result.stop();
    }
  }

  test("the entry resolves the client address and the origin from a saved value once the change counter moves, and not before", async () => {
    await withEcho([], async (seen, storage, origin) => {
      expect(await seen()).toEqual(["127.0.0.1", origin]);
      await storage.settings.set(trustedProxies, ["127.0.0.1"]);
      expect(await seen()).toEqual(["127.0.0.1", origin]);
      await storage.bump();
      expect(await seen()).toEqual([
        "203.0.113.9",
        "https://status.example.test",
      ]);
      // A POST reads no counter of its own: it keeps what the last GET read.
      expect(await seen("POST")).toEqual([
        "203.0.113.9",
        "https://status.example.test",
      ]);
    });
  });

  test("RAAQEB_TRUSTED_PROXIES wins over a saved value", async () => {
    await withEcho(
      ["--trusted-proxies", "10.9.9.9"],
      async (seen, storage, origin) => {
        await storage.settings.set(trustedProxies, ["127.0.0.1"]);
        await storage.bump();
        expect(await seen()).toEqual(["127.0.0.1", origin]);
      }
    );
  });

  test("a saved value is in force on a restart before any GET, so a POST heartbeat names its client", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js":
        "export default { fetch: (r) => new Response(r.headers.get('x-raaqeb-client-address')) };",
    });
    const opened = await openStorage({
      backend: "sqlite",
      file: `${dataDir}/raaqeb.sqlite`,
    });
    if (!opened.ok) {
      throw new Error(opened.message);
    }
    await opened.storage.settings.set(trustedProxies, ["127.0.0.1"]);
    await opened.storage.close();
    await withServer(
      ["--port", "0", "--data-dir", dataDir],
      {},
      dir,
      async (server) => {
        const response = await fetch(
          `http://127.0.0.1:${server.port}/api/heartbeat/token`,
          { headers: { "x-forwarded-for": "203.0.113.9" }, method: "POST" }
        );
        expect(await response.text()).toBe("203.0.113.9");
      }
    );
  });

  test("the sign-in log line names the client rather than the proxy once the value is saved", async () => {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "server/handler.js": `import { handleAuth } from ${JSON.stringify(`${import.meta.dir}/server/auth/auth.ts`)}; export default { fetch: (r, o) => handleAuth(o.context.storage, o.context.boot, r) };`,
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir);
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    const { storage } = result;
    const origin = `http://127.0.0.1:${result.server.port}`;
    const written: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        written.push(String(chunk));
        return true;
      }
    );
    try {
      const booted = await resolveBootSettings(
        {},
        { RAAQEB_DATA_DIR: dataDir }
      );
      if (!booted.ok) {
        throw new Error(booted.message);
      }
      const created = await createOperatorAccount(
        {
          email: "operator@example.com",
          locale: "ar",
          name: "Nadia",
          password: "correct horse battery",
          publicAddress: origin,
        },
        {
          boot: booted.settings,
          opener: databaseOpener(() => undefined),
          storage,
        },
        new Headers({ origin })
      );
      expect(created.ok).toBe(true);
      const signIn = () =>
        fetch(`${origin}/api/auth/sign-in/email`, {
          body: JSON.stringify({
            email: "operator@example.com",
            password: "not the password",
          }),
          headers: {
            "content-type": "application/json",
            origin,
            "x-forwarded-for": "203.0.113.9",
          },
          method: "POST",
        });
      await signIn();
      expect(
        await saveGeneralSettings(
          storage,
          {
            calendar: "gregorian",
            clock: "12h",
            installLanguage: "ar",
            publicAddress: origin,
            releaseCheck: true,
            requestLog: false,
            timeZone: "UTC",
            trustedProxies: ["127.0.0.1"],
          },
          { trustedProxies: [] },
          "owner"
        )
      ).toEqual({ ok: true });
      // The browser loads the sign-in page before it posts the form.
      await fetch(`${origin}/sign-in`);
      await signIn();
    } finally {
      stderr.mockRestore();
      await result.stop();
    }
    const lines = written
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("raaqeb: sign-in"));
    expect(lines).toEqual([
      "raaqeb: sign-in refused from 127.0.0.1",
      "raaqeb: sign-in refused from 203.0.113.9",
    ]);
  });
});

const answerTime = / ms=\d+ /;
const memory = / rss_mb=\d+$/;

describe("the request log", () => {
  /** A handler that answers each path as the test needs: slow, abandoned, a failing probe, or a page the memo may keep. */
  const handler = [
    "export default { fetch: async (r, o) => {",
    "const path = new URL(r.url).pathname;",
    "if (r.url.endsWith('?slow')) await Bun.sleep(1100);",
    // Start ends an abandoned request by throwing the abort's reason.
    "if (r.url.endsWith('?left')) return await new Promise((_, reject) => r.signal.addEventListener('abort', () => reject(r.signal.reason)));",
    "if (path === '/health' && r.headers.has('x-fail')) return new Response('', { status: 503 });",
    "return new Response('ok', { headers: o?.context?.publicTarget ? { 'cache-control': 'public, max-age=0' } : {} });",
    "} };",
  ].join(" ");

  /** A server over a fresh SQLite file, the switch saved on or left off; `lines` reads the request lines it wrote, the time to the answer and the memory each as `<n>`. */
  async function withLog(
    on: boolean,
    body: (
      at: (path: string, init?: RequestInit) => Promise<Response>,
      lines: () => string[],
      storage: Storage
    ) => Promise<void>
  ): Promise<void> {
    const dataDir = await clientBuild({ "raaqeb.sqlite": "" });
    const dir = await serverBuild({
      "client/assets/app-Bx1c9d2e.js": "console.log(1);",
      "server/handler.js": handler,
    });
    const result = await main(["--port", "0", "--data-dir", dataDir], {}, dir);
    if (typeof result === "number" || !result.storage) {
      throw new Error("expected a server over a database");
    }
    const written: string[] = [];
    const stdout = spyOn(process.stdout, "write").mockImplementation(
      (chunk) => {
        written.push(String(chunk));
        return true;
      }
    );
    const at = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${result.server.port}${path}`, {
        ...init,
        headers: { "user-agent": "curl/8.5.0", ...init.headers },
      });
    const lines = () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("raaqeb: request "))
        .map((line) =>
          line.replace(answerTime, " ms=<n> ").replace(memory, " rss_mb=<n>")
        );
    try {
      if (on) {
        await result.storage.settings.set(requestLogEnabled, true);
        await result.storage.bump();
      }
      await body(at, lines, result.storage);
    } finally {
      stdout.mockRestore();
      await result.stop();
    }
  }

  test("while the switch is off, no request writes a line", async () => {
    await withLog(false, async (at, lines) => {
      expect(await (await at("/sign-out?x=1")).text()).toBe("ok");
      await at("/api/v2/monitors", { body: "{}", method: "POST" });
      await at("/sign-in", {
        body: new Uint8Array(9 * 1024 * 1024),
        method: "POST",
      });
      const leaving = new AbortController();
      const left = at("/sign-out?left", { signal: leaving.signal }).catch(
        () => undefined
      );
      await Bun.sleep(50);
      leaving.abort();
      await left;
      await Bun.sleep(100);
      expect(lines()).toEqual([]);
    });
  });

  test("once the switch is saved on and the change counter moves, each request that reaches the handler writes one line naming its kind; a static file writes none", async () => {
    await withLog(true, async (at, lines) => {
      await at("/forgot-password?page=2");
      await at("/_serverFn/4f2a9c", { body: "{}", method: "POST" });
      await at("/api/auth/get-session");
      await at("/api/openapi.json");
      await at("/api/heartbeat/s3cret", { method: "POST" });
      await at("/assets/app-Bx1c9d2e.js");
      expect(
        (
          await at("/sign-in", {
            body: new Uint8Array(9 * 1024 * 1024),
            method: "POST",
          })
        ).status
      ).toBe(413);
      expect(lines()).toEqual([
        "raaqeb: request method=GET path=/forgot-password status=200 ms=<n> ip=127.0.0.1 kind=page browser=curl/8.5",
        "raaqeb: request method=POST path=/_serverFn/4f2a9c status=200 ms=<n> ip=127.0.0.1 kind=function browser=curl/8.5",
        "raaqeb: request method=GET path=/api/auth/get-session status=200 ms=<n> ip=127.0.0.1 kind=auth browser=curl/8.5",
        "raaqeb: request method=GET path=/api/openapi.json status=200 ms=<n> ip=127.0.0.1 kind=api browser=curl/8.5",
        "raaqeb: request method=POST path=/api/heartbeat/<token> status=200 ms=<n> ip=127.0.0.1 kind=api browser=curl/8.5",
        "raaqeb: request method=POST path=/sign-in status=413 ms=<n> ip=127.0.0.1 kind=page browser=curl/8.5",
      ]);
    });
  });

  test("a status page's view is logged as a status page, and as cached once the memo holds it", async () => {
    await withLog(true, async (at, lines, storage) => {
      const created = await createPage(storage, {
        locale: "ar",
        slug: "main",
        title: "Main",
      });
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await publish(storage, created.page.id);
      await at("/");
      await at("/");
      expect(lines()).toEqual([
        "raaqeb: request method=GET path=/ status=200 ms=<n> ip=127.0.0.1 kind=status-page browser=curl/8.5",
        "raaqeb: request method=GET path=/ status=200 ms=<n> ip=127.0.0.1 kind=status-page cached=true browser=curl/8.5",
      ]);
    });
  });

  test("a health probe answered 200 within a second writes no line; a failing one writes one with the process's memory", async () => {
    await withLog(true, async (at, lines) => {
      await at("/health");
      await at("/health", { headers: { "x-fail": "1" } });
      expect(lines()).toEqual([
        "raaqeb: request method=GET path=/health status=503 ms=<n> ip=127.0.0.1 kind=api browser=curl/8.5 rss_mb=<n>",
      ]);
    });
  });

  test("a request slower than a second carries the process's memory", async () => {
    await withLog(true, async (at, lines) => {
      await at("/sign-out?slow");
      expect(lines()).toEqual([
        "raaqeb: request method=GET path=/sign-out status=200 ms=<n> ip=127.0.0.1 kind=page browser=curl/8.5 rss_mb=<n>",
      ]);
    });
  });

  test("a client that leaves before the answer still gets a line, its status named closed", async () => {
    await withLog(true, async (at, lines) => {
      const leaving = new AbortController();
      const left = at("/sign-out?left", { signal: leaving.signal }).catch(
        () => undefined
      );
      await Bun.sleep(100);
      leaving.abort();
      await left;
      const deadline = Date.now() + 2000;
      while (lines().length === 0 && Date.now() < deadline) {
        // biome-ignore lint/performance/noAwaitInLoops: polling for the line the server writes once the client left
        await Bun.sleep(20);
      }
      expect(lines()).toEqual([
        "raaqeb: request method=GET path=/sign-out status=closed ms=<n> ip=127.0.0.1 kind=page browser=curl/8.5",
      ]);
    });
  });
});
