/**
 * The `raaqeb` command entry and the Bun.serve entry (ADR-0002).
 * `serve`, the default command, resolves the boot settings, loads the build,
 * opens and migrates the database when one is known, serves the
 * Vite client build from memory as static routes and hands every other
 * request to the Start fetch handler built from src/handler.ts into
 * dist/server/handler.js, and starts the scheduler over the open storage.
 * SIGTERM and SIGINT, and SIGHUP on Windows, stop scheduler and server, wait for auth
 * mail still sending, then close storage.
 * `health` calls GET /health at the boot address and exits 0 or 1; `reset-password` mints a reset link over the same database, and `set-address` stores the public address there.
 * Vite builds this file into dist/server/server.js beside the
 * handler, so the two share one module tree, and `bun run start`,
 * the e2e servers and the compiled binary all run that build; the build
 * carries its migrations under dist/migrations. Run from the
 * source tree, as tests do, it loads the handler's separate copy. Not used by
 * `vite dev`. Every GET or HEAD that shows
 * a status page's view, a view's document, or its summary, badge or feed
 * is answered through the memo,
 * which resolves the page and locale before anything renders
 * and hands them to the route as the request context's public target; an
 * unpublished page's, to the signed-in operator alone and outside the memo
 *.
 * Every HTML response leaves with the security headers.
 */
import type { ServerEntry } from "@tanstack/react-start/server-entry";
import { mailSettled } from "./server/auth/auth.ts";
import {
  needsTerminal,
  processTerminal,
  resetPasswordCommand,
  type Terminal,
} from "./server/auth/command.ts";
import { isOperator } from "./server/auth/session.ts";
import { parseCommandLine } from "./server/boot/commandline.ts";
import type { InstallKey } from "./server/boot/installkey.ts";
import {
  clientAddress,
  clientAddressHeader,
  inRanges,
  requestOrigin,
  requestOriginHeader,
} from "./server/boot/proxies.ts";
import {
  type BootSettings,
  resolveAddress,
  resolveBootSettings,
} from "./server/boot/settings.ts";
import { liveIo } from "./server/checks/io.ts";
import { error as logError, info as logInfo } from "./server/log.ts";
import { createPublicMemo } from "./server/memo/public.ts";
import type { PublicTarget } from "./server/pages/public.ts";
import { healthCommand, healthUrl } from "./server/scheduler/health.ts";
import type { MonitorEvent } from "./server/scheduler/schedule.ts";
import {
  createScheduler,
  type Scheduler,
} from "./server/scheduler/scheduler.ts";
import { setAddressCommand } from "./server/settings/command.ts";
import { heldTrustedProxies } from "./server/settings/proxies.ts";
import {
  type DatabaseOpener,
  databaseOpener,
  locateDatabase,
  type OpenStorageOptions,
  openStorage,
  type Storage,
} from "./server/storage/storage.ts";
import { importPath } from "./shared/schemas/export-page.ts";
import type {
  MaintenanceStage,
  MaintenanceWindow,
} from "./shared/schemas/maintenance.ts";
import { reasonName } from "./shared/schemas/reason.ts";

/**
 * The build this entry serves. Compiled, the entry sits at the root of the
 * embedded dist tree; built, it is dist/server/server.js beside the handler;
 * run from the source tree, as tests do, the build is ../dist.
 */
function ownBuildDir(): string {
  if (Bun.isStandaloneExecutable) {
    return import.meta.dir;
  }
  return import.meta.path.endsWith(".ts")
    ? `${import.meta.dir}/../dist`
    : `${import.meta.dir}/..`;
}

/**
 * Where the open storage lives for the life of the process: nothing during
 * onboarding until the database screen opens one, which then serves every
 * later request.
 */
export interface StorageHolder {
  current: Storage | undefined;
  /** The scheduler over the current storage; starts with it. */
  scheduler: Scheduler | undefined;
}

/** A running `serve`: the server and the storage behind it, stopped together. */
export interface Running {
  readonly server: Bun.Server<undefined>;
  /** Stops the server and closes the storage. */
  stop: () => Promise<void>;
  /** The open storage, or nothing during onboarding before the database screen. */
  readonly storage: Storage | undefined;
}

/** The running command, or the exit code when the command ends. */
export type MainResult = Running | number;

/** What a test hands the entry: the storage options but the migrations, which are the build's, the terminal the reset command talks to (the process's own by default), and Bun's idle timeout in seconds (Bun's own by default). */
export interface MainOptions extends Omit<OpenStorageOptions, "migrations"> {
  readonly idleTimeoutSeconds?: number;
  readonly terminal?: Terminal;
}

/**
 * Runs one command. Exit code 2 is a command line the entry does not accept,
 * 1 a boot or build failure. The address is never printed: it is the value of
 * two boot settings.
 */
export async function main(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dir: string,
  mainOptions: MainOptions = {}
): Promise<MainResult> {
  // Storage migrates with the migrations the build carries.
  const options = { ...mainOptions, migrations: `${dir}/migrations` };
  const line = parseCommandLine(args);
  if (!line.ok) {
    logError(line.message);
    return 2;
  }
  if (line.command === "health") {
    // Only the address is needed: no data directory is created and no install key minted.
    const address = resolveAddress(line.flags, env);
    if (!address.ok) {
      logError(address.message);
      return 2;
    }
    return await healthCommand(healthUrl(address.host, address.port), fetch);
  }
  const booted = await resolveBootSettings(line.flags, env);
  if (!booted.ok) {
    logError(booted.message);
    return 1;
  }
  if (line.command === "reset-password") {
    return await resetPassword(
      booted.settings,
      line.interactive,
      options.terminal ?? processTerminal(),
      options
    );
  }
  // The command line refuses set-address without an origin.
  if (line.command === "set-address" && line.address !== undefined) {
    const { address } = line;
    const terminal = options.terminal ?? processTerminal();
    return await besideServer(booted.settings, terminal, options, (storage) =>
      setAddressCommand(storage, address, terminal)
    );
  }
  for (const note of booted.notes) {
    logInfo(note);
  }
  // The build is checked before the database, so a process that cannot serve migrates nothing.
  const handler = await loadServerEntry(`${dir}/server/handler.js`);
  if (!handler) {
    logError("no server build found; run `bun run build` first");
    return 1;
  }
  const routes = await preloadAssets(`${dir}/client`);
  const location = await locateDatabase(booted.settings);
  const holder: StorageHolder = { current: undefined, scheduler: undefined };
  const attach = (storage: Storage) => {
    holder.current = storage;
    holder.scheduler = startScheduler(storage, booted.settings.installKey);
  };
  if (location) {
    const opened = await openStorage(location, options);
    if (!opened.ok) {
      logError(opened.message);
      return 1;
    }
    for (const note of opened.notes) {
      logInfo(note);
    }
    attach(opened.storage);
  } else {
    logInfo("no database yet; onboarding will choose one");
  }
  const opener = databaseOpener(attach, options);
  let server: Bun.Server<undefined>;
  try {
    server = serve(
      booted.settings,
      handler,
      routes,
      holder,
      opener,
      options.idleTimeoutSeconds
    );
  } catch {
    // Bun's own message repeats the port; the rule is to name the settings only.
    logError(
      "cannot listen: RAAQEB_HOST and RAAQEB_PORT name an address that is not available"
    );
    await holder.scheduler?.stop();
    await holder.current?.close();
    return 1;
  }
  logInfo("listening");
  return {
    server,
    stop: async () => {
      await holder.scheduler?.stop();
      await server.stop(true);
      // A reset link or a code handed off after its answer still reads the storage.
      await mailSettled();
      await holder.current?.close();
    },
    get storage() {
      return holder.current;
    },
  };
}

/**
 * `raaqeb reset-password`: the same data directory and boot
 * settings as `serve`, the database opened beside a running server (SQLite
 * WAL and Postgres both allow it) and closed when the command ends.
 */
async function resetPassword(
  settings: BootSettings,
  interactive: boolean,
  terminal: Terminal,
  options: OpenStorageOptions
): Promise<number> {
  if (interactive && !terminal.interactive) {
    // Refused before the database opens, so a pipe cannot migrate anything.
    terminal.err(needsTerminal);
    return 2;
  }
  return await besideServer(settings, terminal, options, (storage) =>
    resetPasswordCommand(storage, settings, { interactive }, terminal)
  );
}

/**
 * Runs a command over the install's database, opened beside a running
 * server (SQLite WAL and Postgres both allow it) and closed when the command
 * ends; exit 1 when there is no database yet or it does not open.
 */
async function besideServer(
  settings: BootSettings,
  terminal: Pick<Terminal, "err">,
  options: OpenStorageOptions,
  run: (storage: Storage) => Promise<number>
): Promise<number> {
  const location = await locateDatabase(settings);
  if (!location) {
    terminal.err("there is no database yet; finish onboarding first");
    return 1;
  }
  const opened = await openStorage(location, options);
  if (!opened.ok) {
    terminal.err(opened.message);
    return 1;
  }
  try {
    return await run(opened.storage);
  } finally {
    await opened.storage.close();
  }
}

/**
 * The scheduler over an open storage, started: each monitor event and each
 * maintenance window it moves is one log line beside the notifications the
 * scheduler queues, a tick five minutes old exits
 * the process non-zero for the supervisor, and the install key
 * opens the monitors' credentials.
 */
function startScheduler(storage: Storage, installKey: InstallKey): Scheduler {
  const scheduler = createScheduler(storage, liveIo(), {
    installKey,
    onEvent: (event) => logInfo(eventLine(event)),
    onMaintenance: (window) => logInfo(maintenanceLine(window)),
    onStale: (sinceMs) => {
      logError(
        `the scheduler has not ticked for ${Math.round(sinceMs / 1000)} seconds; exiting so the supervisor restarts raaqeb`
      );
      process.exit(1);
    },
  });
  scheduler.start();
  return scheduler;
}

const eventWords: Readonly<Record<MonitorEvent["kind"], string>> = {
  certificate_expiring: "has a certificate expiring",
  degraded_ended: "is no longer degraded",
  degraded_started: "is degraded",
  down: "is down",
  recovered: "recovered",
};

/** One log line per monitor event: the monitor's id, the event, a down event's reason, and when an expiring certificate ends. */
export function eventLine(event: MonitorEvent): string {
  const line = `monitor ${event.monitorId} ${eventWords[event.kind]}`;
  if (event.kind === "certificate_expiring") {
    return `${line} at ${new Date(event.validTo).toISOString()}`;
  }
  return event.kind === "down"
    ? `${line} (${reasonName(event.reason) ?? event.reason})`
    : line;
}

const stageWords: Readonly<Record<MaintenanceStage, string>> = {
  completed: "completed",
  in_progress: "started",
  scheduled: "is scheduled",
};

/** One log line per maintenance window the scheduler moved: its id and what happened. */
export function maintenanceLine(window: MaintenanceWindow): string {
  return `maintenance window ${window.id} ${stageWords[window.stage]}`;
}

/** The largest body a request other than an import may carry: Start reads a server function's whole body before any check, and the largest one the admin sends is a 1 MB cover image. */
export const bodyLimitBytes = 8 * 1024 * 1024;

/** The largest export an import takes. */
const uploadLimitBytes = 4 * 1024 ** 3;

/** Whether a request's body is refused before anything reads it: over the limit, or streamed with no length to judge; an import's upload streams in whole. A body is judged by itself, not by transfer-encoding, which HTTP/2 never sends. */
function oversized(request: Request): boolean {
  if (new URL(request.url).pathname === importPath) {
    return false;
  }
  const length = request.headers.get("content-length");
  return length === null
    ? request.body !== null
    : Number(length) > bodyLimitBytes;
}

/**
 * Starts Bun.serve on the resolved settings with the loaded handler. Every
 * request carries the open storage, the boot settings and the database opener
 * as Start's request context, so loaders and server functions reach the
 * database without a module-level singleton; the opener migrates with the
 * build's migrations, which the entry names.
 * The client address, resolved from the socket peer behind the trusted
 * proxies (the variable's, else the setting's as of the last change counter
 * read), travels in one header the entry always overwrites; the
 * socket peer, and whether those proxies hold it, is read on demand from the
 * request context by the setup checks.
 * A public request goes through the memo first.
 */
export function serve(
  settings: BootSettings,
  handler: ServerEntry,
  routes: Record<string, Response>,
  holder: StorageHolder,
  opener: DatabaseOpener,
  idleTimeoutSeconds?: number
): Bun.Server<undefined> {
  // An unpublished page shows its views to the signed-in operator alone.
  const memo = createPublicMemo({
    now: Date.now,
    operator: (request) =>
      isOperator(holder.current, settings, request.headers),
  });
  // Held in memory, read again only when the change counter moves.
  const proxies = heldTrustedProxies(settings.trustedProxies);
  const server: Bun.Server<undefined> = Bun.serve({
    development: false,
    fetch: async (request) => {
      if (oversized(request)) {
        return new Response("Payload Too Large", { status: 413 });
      }
      const storage = holder.current;
      // A GET or HEAD reads the change counter once, for the memo and for the trusted proxies; any other request keeps what the last one read.
      const counter =
        storage && (request.method === "GET" || request.method === "HEAD")
          ? memo.read(storage)
          : undefined;
      const trusted = await proxies(storage, await counter);
      const resolved = withClientAddress(request, server, trusted);
      const context = (publicTarget: PublicTarget | undefined) => ({
        boot: settings,
        // The entry's own request: the one Bun's idle timer belongs to.
        holdOpen: (seconds: number) => server.timeout(request, seconds),
        missingView: () => memo.missing(resolved),
        opener,
        // Read only by the page that asks (the setup checks), so a request pays nothing for it.
        peer: () => {
          const address = server.requestIP(request)?.address;
          return address === undefined
            ? undefined
            : { address, trusted: inRanges(trusted)(address) };
        },
        publicTarget,
        scheduler: holder.scheduler,
        storage,
        unpublished: () => memo.unpublished(resolved),
      });
      const memoised = await memo.answer(
        resolved,
        storage,
        async (target) =>
          // A HEAD renders as a GET, so the stored entry has its body.
          await handler.fetch(new Request(resolved, { method: "GET" }), {
            context: context(target),
          }),
        counter
      );
      const response =
        memoised ??
        (await handler.fetch(resolved, { context: context(undefined) }));
      if (!isHtml(response)) {
        return response;
      }
      return withSecurityHeaders(response, {
        framable: memoised !== undefined,
        // The address the memo read with the change counter on this GET: no read of its own.
        https: memo.publicAddress()?.startsWith("https:") ?? false,
      });
    },
    hostname: settings.host,
    idleTimeout: idleTimeoutSeconds,
    // HTTP/2 to a client that opens with its preface, as a proxy with an HTTP/2 backend does (Fly's h2_backend); HTTP/1.1 to any other.
    http2: true,
    // An import streams its upload, so only Bun's own limit bounds it; every other body stops at `bodyLimitBytes`.
    maxRequestBodySize: uploadLimitBytes,
    port: settings.port,
    // With development false Bun sets SO_REUSEPORT unless told not to, and a
    // second raaqeb would share the port silently.
    reusePort: false,
    routes,
  });
  return server;
}

/**
 * The signal Start sees for a request: it aborts when the client's does, with
 * a plain string. Start ends an abandoned request by throwing the reason, and
 * h3 prints any Error it is handed as a stack; a
 * client that left reads no answer, so nothing is logged.
 */
function quietSignal(signal: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort("the client closed the connection");
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

/**
 * The headers every HTML response carries:
 * nosniff and the referrer policy always; frame-ancestors 'none' and
 * X-Frame-Options DENY unless the response is a status page's view, which a
 * site may embed; HSTS only when the stored public address is https. No
 * full policy in v1: Start's inline scripts and the operator's custom CSS would break under one.
 */
function withSecurityHeaders(
  response: Response,
  view: { readonly framable: boolean; readonly https: boolean }
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  if (!view.framable) {
    headers.set("content-security-policy", "frame-ancestors 'none'");
    headers.set("x-frame-options", "DENY");
  }
  if (view.https) {
    headers.set("strict-transport-security", "max-age=31536000");
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** Only an HTML response is a page a site could frame or sniff; the rest keep their own headers, a page image its sandbox policy. */
function isHtml(response: Response): boolean {
  return response.headers.get("content-type")?.startsWith("text/html") ?? false;
}

/** The request with the resolved client address and the origin the client used in Raaqeb's two headers, replacing any the client sent, and an abort Start can end quietly. */
export function withClientAddress(
  request: Request,
  server: Pick<Bun.Server<undefined>, "requestIP">,
  trustedProxies: readonly string[]
): Request {
  const peer = server.requestIP(request)?.address;
  const resolved: [string, string | undefined][] = [
    [
      clientAddressHeader,
      clientAddress(
        peer,
        request.headers.get("x-forwarded-for"),
        trustedProxies
      ),
    ],
    [
      requestOriginHeader,
      requestOrigin(
        request.url,
        peer,
        request.headers.get("x-forwarded-proto"),
        request.headers.get("x-forwarded-host"),
        trustedProxies
      ),
    ],
  ];
  const headers = new Headers(request.headers);
  for (const [name, value] of resolved) {
    if (value === undefined) {
      // A unix socket has no peer, a forged forward no origin: no value at all rather than one the client chose.
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }
  return new Request(request, { headers, signal: quietSignal(request.signal) });
}

/** Cache-Control for a client asset: hashed Vite output is immutable, anything else revalidates. */
export function cacheControl(urlPath: string): string {
  return urlPath.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

/**
 * Reads every file under the client build directory into memory, keyed by URL
 * path, as the `routes` of Bun.serve. Bun answers these before `fetch` runs and
 * handles ETag, If-None-Match, 304 and HEAD itself
 * (docs/deps/bun/docs/runtime/http/routing.mdx, "Static responses").
 */
export async function preloadAssets(
  clientDir: string
): Promise<Record<string, Response>> {
  const routes: Record<string, Response> = {};
  let files: string[];
  try {
    files = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: clientDir })
    );
  } catch {
    // No client build yet: the caller decides what an empty route table means.
    return routes;
  }
  await Promise.all(
    files.map(async (relative) => {
      const file = Bun.file(`${clientDir}/${relative}`);
      // Windows answers `assets\x.js`; a URL path has slashes.
      const urlPath = `/${relative.replaceAll("\\", "/")}`;
      routes[urlPath] = new Response(await file.bytes(), {
        headers: {
          "cache-control": cacheControl(urlPath),
          "content-type": file.type,
        },
      });
    })
  );
  return routes;
}

/** The fetch handler Vite built, or nothing when the build is missing or is not one. */
export async function loadServerEntry(
  path: string
): Promise<ServerEntry | undefined> {
  if (!(await Bun.file(path).exists())) {
    return;
  }
  const loaded: unknown = (await import(path)).default;
  return isServerEntry(loaded) ? loaded : undefined;
}

function isServerEntry(value: unknown): value is ServerEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}

/**
 * The signals that stop `serve` cleanly: SIGTERM, a supervisor's and a
 * container's stop, and SIGINT, Ctrl+C, everywhere; SIGHUP only on Windows,
 * where it means the console window closed. Elsewhere a listener would
 * replace the ignore `nohup` hands down, and a logout would stop the server.
 */
export function stopSignals(
  platform: NodeJS.Platform = process.platform
): NodeJS.Signals[] {
  return platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGHUP"]
    : ["SIGTERM", "SIGINT"];
}

if (import.meta.main) {
  const result = await main(Bun.argv.slice(2), process.env, ownBuildDir());
  if (typeof result === "number") {
    process.exit(result);
  }
  // Each stop closes the pool and checkpoints the write-ahead log.
  const stop = () => {
    logInfo("stopping");
    result.stop().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  for (const signal of stopSignals()) {
    process.once(signal, stop);
  }
}
