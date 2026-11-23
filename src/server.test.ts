import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { connect } from "node:http2";
import { authFor, operatorName } from "./server/auth/auth.ts";
import { resetPasswordCommand, type Terminal } from "./server/auth/command.ts";
import { resolveBootSettings } from "./server/boot/settings.ts";
import { createOperatorAccount } from "./server/onboarding/onboarding.ts";
import { publish } from "./server/pages/fixture.ts";
import { createPage } from "./server/pages/pages.ts";
import { currentVersion } from "./server/release/release.ts";
import { publicAddress } from "./server/settings/address.ts";
import { saveGeneralSettings } from "./server/settings/general.ts";
import { trustedProxies } from "./server/settings/proxies.ts";
import { requestLogEnabled } from "./server/settings/request-log.ts";
import { runSql } from "./server/storage/fixture.ts";
import {
  localMigrations,
  migrationsFolder,
} from "./server/storage/migrationfiles.ts";
import {
  databaseOpener,
  locateDatabase,
  openStorage,
  type Storage,
} from "./server/storage/storage.ts";
import {
  cacheControl,
  eventLine,
  loadServerEntry,
  main,
  maintenanceLine,
  preloadAssets,
  type RenderLane,
  type StrangerPace,
  stopSignals,
} from "./server.ts";
import { reasons } from "./shared/schemas/reason.ts";

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

/** A render pace for a test: renders `gapMs` apart, room for 100 in every lane but those named, and the checks unpaced unless given. */
function testPace(
  gapMs: number,
  room: Partial<Record<RenderLane, number>>,
  checks: { readonly gapMs: number; readonly waiting: number } = {
    gapMs: 0,
    waiting: 100,
  }
): StrangerPace {
  const lanes: RenderLane[] = [
    "cold",
    "onboarding",
    "others",
    "pages",
    "refresh",
    "reset",
    "subscriptions",
  ];
  return {
    checks: {
      burst: 1,
      gapMs: checks.gapMs,
      overrun: 2,
      turnMs: 5000,
      waiting: { checks: checks.waiting },
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
  body: (server: Bun.Server<undefined>) => Promise<void>
): Promise<void> {
  const result = await main(args, env, dir);
  if (typeof result === "number") {
    throw new Error(`expected a server, got exit code ${result}`);
  }
  try {
    await body(result.server);
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

  test("a request body over 8 MB, or one with no length, is refused before the handler, except an import's, which streams in whole", async () => {
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
        expect((await post("/sign-in", large)).status).toBe(413);
        const limit = new Uint8Array(8 * 1024 * 1024);
        expect(await (await post("/sign-in", limit)).text()).toBe(
          `read ${limit.length}`
        );
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
      async (server) => {
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
        const heartbeat = "/api/heartbeat/abc";
        expect(await (await post(heartbeat, chunked())).text()).toBe("read 10");
        expect(
          (await post(heartbeat, new Uint8Array(9 * 1024 * 1024))).status
        ).toBe(413);
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

  test("over HTTP/2 a body over 8 MB, or one with no length, is refused before the handler, as over HTTP/1.1; an import's streams in whole", async () => {
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
      await main(["reset-password", "--data-dir", dataDir], {}, dir, {
        terminal,
      })
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

describe("a stop by signal", () => {
  test("SIGTERM and Ctrl+C's SIGINT each stop cleanly, the write-ahead log checkpointed into the SQLite file", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one server at a time
      const { child, output, wal } = await servingOverSqlite([
        "bun",
        "src/server.ts",
      ]);
      expect(output, signal).toContain("listening");
      expect(await wal()).toBe(true);
      child.kill(signal);
      expect(await child.exited, signal).toBe(0);
      expect(await wal(), signal).toBe(false);
    }
  });

  test("SIGHUP stops the server on Windows alone, where it means the console window closed; elsewhere SIGTERM and SIGINT", () => {
    expect(stopSignals("linux")).toEqual(["SIGTERM", "SIGINT"]);
    expect(stopSignals("darwin")).toEqual(["SIGTERM", "SIGINT"]);
    expect(stopSignals("win32")).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
  });

  test("a server started under nohup, with SIGHUP ignored, keeps serving when its terminal hangs up", async () => {
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
  });
});

describe("the security headers of an HTML response", () => {
  /** A handler answering HTML everywhere, public at a status page's view, a page image under its own sandbox policy, the cover as HTML under that policy, and the summary as JSON. */
  const handler = [
    "export default { fetch: (r) => {",
    "const path = new URL(r.url).pathname;",
    "if (path.endsWith('.json')) return Response.json({}, { headers: { 'cache-control': 'public, max-age=0, must-revalidate' } });",
    "if (path === '/api/pages/some-id/cover') return new Response('<script></script>', { headers: { 'content-type': 'text/html', 'content-security-policy': \"default-src 'none'; style-src 'unsafe-inline'; sandbox\" } });",
    "if (path.startsWith('/api/pages/')) return new Response('png', { headers: { 'content-type': 'image/png', 'content-security-policy': \"default-src 'none'; style-src 'unsafe-inline'; sandbox\", 'x-content-type-options': 'nosniff' } });",
    "return new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': path === '/' ? 'public, max-age=0, must-revalidate' : 'no-store' } });",
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

  test("an admin page refuses every frame by Content-Security-Policy frame-ancestors, and a status page's view sets no policy", async () => {
    await withPage(undefined, async (at) => {
      expect(
        await valuesOf(at, "content-security-policy", [...notViews, "/"])
      ).toEqual([
        "frame-ancestors 'none'",
        "frame-ancestors 'none'",
        "frame-ancestors 'none'",
        null,
      ]);
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
          { trustedProxies: [] }
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
