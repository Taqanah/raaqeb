/**
 * The `raaqeb` command entry and the Bun.serve entry (ADR-0002).
 * `serve`, the default command, resolves the boot settings, loads the build,
 * opens and migrates the database when one is known, serves the
 * Vite client build from memory as static routes and hands every other
 * request to the Start fetch handler built from src/handler.ts into
 * dist/server/handler.js, and starts the scheduler over the open storage.
 * SIGTERM and SIGINT, and SIGHUP on Windows, stop scheduler and server, wait for auth
 * mail still sending, then close storage.
 * `--version` and `--help` print and exit 0 before anything is read. `health` calls GET /health at the boot address and exits 0 or 1; `reset-password` mints a reset link over the same database, and `set-address` stores the public address there.
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
 * unpublished page's, to the signed-in operator alone and outside the memo;
 * a private page's, only to a request its page access lets in, and a try at
 * its password, a form POST at one of its views, through the memo too.
 * Every HTML response leaves with the security headers.
 */
import type { ServerEntry } from "@tanstack/react-start/server-entry";
import { authFor, mailSettled, resetLinkOpen } from "./server/auth/auth.ts";
import {
  needsTerminal,
  processTerminal,
  type ResetPasswordOptions,
  resetPasswordCommand,
  type Terminal,
} from "./server/auth/command.ts";
import { readInvitation } from "./server/auth/invitation.ts";
import { keepAuthEmailChannel } from "./server/auth/mail.ts";
import { carriesSession, isOperator } from "./server/auth/session.ts";
import {
  type CommandLine,
  helpText,
  parseCommandLine,
} from "./server/boot/commandline.ts";
import type { InstallKey } from "./server/boot/installkey.ts";
import {
  clientAddress,
  clientAddressHeader,
  clientNetwork,
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
import { createPublicMemo, type RenderMissing } from "./server/memo/public.ts";
import { onboardingStep } from "./server/onboarding/onboarding.ts";
import {
  type BodyBudget,
  type BodyLimits,
  busyAnswer,
  createBodyBudget,
  createPace,
  type Pace,
  type PaceLimits,
} from "./server/pace.ts";
import { type PublicTarget, rendersDocument } from "./server/pages/public.ts";
import { probeCommand } from "./server/probes/command.ts";
import { currentVersion } from "./server/release/release.ts";
import { closed, type MemoAnswer, requestLine } from "./server/request-log.ts";
import { healthCommand, healthUrl } from "./server/scheduler/health.ts";
import type { MonitorEvent } from "./server/scheduler/schedule.ts";
import {
  createScheduler,
  type Scheduler,
} from "./server/scheduler/scheduler.ts";
import { setAddressCommand } from "./server/settings/command.ts";
import { heldTrustedProxies } from "./server/settings/proxies.ts";
import { heldRequestLog } from "./server/settings/request-log.ts";
import {
  type DatabaseOpener,
  databaseOpener,
  locateDatabase,
  type OpenStorageOptions,
  openStorage,
  type Storage,
} from "./server/storage/storage.ts";
import { subscriptionView } from "./server/subscriptions/subscriptions.ts";
import { importPath } from "./shared/schemas/export-page.ts";
import { heartbeatPathPrefix } from "./shared/schemas/heartbeat.ts";
import type {
  MaintenanceStage,
  MaintenanceWindow,
} from "./shared/schemas/maintenance.ts";
import { statusPageHeader } from "./shared/schemas/page.ts";
import { reasonName } from "./shared/schemas/reason.ts";
import { subscriptionTokenSchema } from "./shared/schemas/subscription.ts";

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

/** What a test hands the entry: the storage options but the migrations, which are the build's, the terminal the reset command talks to (the process's own by default), Bun's idle timeout in seconds (Bun's own by default), and the pace of renders without a session (`strangerPace` by default). */
export interface MainOptions extends Omit<OpenStorageOptions, "migrations"> {
  readonly idleTimeoutSeconds?: number;
  readonly pace?: StrangerPace;
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
  // These need no data directory and mint no install key.
  const answered = await beforeBoot(
    line,
    env,
    options.terminal ?? processTerminal()
  );
  if (answered !== undefined) {
    return answered;
  }
  const booted = await resolveBootSettings(line.flags, env);
  if (!booted.ok) {
    logError(booted.message);
    return 1;
  }
  if (line.command === "reset-password") {
    return await resetPassword(
      booted.settings,
      { email: line.email, interactive: line.interactive },
      options.terminal ?? processTerminal(),
      options
    );
  }
  if (line.command === "probe") {
    logError("the probe runs through `runCommand`, not `main`");
    return 2;
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
  // The port is known free before the database opens, so a second process on a busy port migrates nothing and starts no scheduler.
  if (!portIsFree(booted.settings)) {
    logError(cannotListen);
    return 1;
  }
  const routes = await preloadAssets(`${dir}/client`);
  const location = await locateDatabase(booted.settings);
  const holder: StorageHolder = { current: undefined, scheduler: undefined };
  const attach = async (storage: Storage, applied: readonly string[]) => {
    await keepSignInMail(storage, applied);
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
    await attach(opened.storage, opened.applied);
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
      options.idleTimeoutSeconds,
      options.pace
    );
  } catch {
    // Another process took the port since the check above.
    logError(cannotListen);
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

/** Bun's own message repeats the port; the rule is to name the settings only. */
const cannotListen =
  "cannot listen: RAAQEB_HOST and RAAQEB_PORT name an address that is not available";

/** Whether the address can be listened on now: bound and let go at once, with `reusePort` off as `serve` has it, so it refuses what `serve` would. */
function portIsFree(settings: BootSettings): boolean {
  try {
    Bun.serve({
      fetch: () => new Response(),
      hostname: settings.host,
      port: settings.port,
      reusePort: false,
    }).stop(true);
    return true;
  } catch {
    return false;
  }
}

/** The commands that answer before the boot settings resolve: the version, the help and `health`, which needs only the address. Nothing for the rest. */
async function beforeBoot(
  line: Extract<CommandLine, { ok: true }>,
  env: Readonly<Record<string, string | undefined>>,
  terminal: Terminal
): Promise<number | undefined> {
  if (line.command === "version" || line.command === "help") {
    terminal.out(
      line.command === "version"
        ? `raaqeb ${currentVersion}`
        : helpText(currentVersion)
    );
    return 0;
  }
  if (line.command !== "health") {
    return;
  }
  const address = resolveAddress(line.flags, env);
  if (!address.ok) {
    logError(address.message);
    return 2;
  }
  return await healthCommand(healthUrl(address.host, address.port), fetch);
}

/**
 * `raaqeb reset-password`: the same data directory and boot
 * settings as `serve`, the database opened beside a running server (SQLite
 * WAL and Postgres both allow it) and closed when the command ends.
 */
async function resetPassword(
  settings: BootSettings,
  reset: ResetPasswordOptions,
  terminal: Terminal,
  options: OpenStorageOptions
): Promise<number> {
  if (reset.interactive && !terminal.interactive) {
    // Refused before the database opens, so a pipe cannot migrate anything.
    terminal.err(needsTerminal);
    return 2;
  }
  return await besideServer(settings, terminal, options, (storage) =>
    resetPasswordCommand(storage, settings, reset, terminal)
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
    // A command may be the first to open an upgraded install.
    await keepSignInMail(opened.storage, opened.applied);
    return await run(opened.storage);
  } finally {
    await opened.storage.close();
  }
}

/** The migration that made the one operator an owner: data it runs on had no admin to make a channel. */
const operatorAccountsMigration = "20261021042422_operator_accounts";

/** Before any request or command reads it: an install from before the sign-in mail choice keeps the channel it used. Logs a failure, never throws. */
async function keepSignInMail(
  storage: Storage,
  applied: readonly string[]
): Promise<void> {
  await keepAuthEmailChannel(
    storage,
    applied.includes(operatorAccountsMigration)
  ).catch(() =>
    logError("the email channel sign-in mail goes through could not be kept")
  );
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
  domain_expiring: "has a domain registration expiring",
  down: "is down",
  recovered: "recovered",
};

/** One log line per monitor event: the monitor's id, the event, a down event's reason and the locations that saw it, and when an expiring certificate or domain registration ends. */
export function eventLine(event: MonitorEvent): string {
  const line = `monitor ${event.monitorId} ${eventWords[event.kind]}`;
  if (event.kind === "certificate_expiring") {
    return `${line} at ${new Date(event.validTo).toISOString()}`;
  }
  if (event.kind === "domain_expiring") {
    return `${line}: ${event.domain} at ${new Date(event.expiresAt).toISOString()}`;
  }
  if (event.kind !== "down") {
    return line;
  }
  const down = `${line} (${reasonName(event.reason) ?? event.reason})`;
  // A probe by its id: its name is the operator's text, which a log line never carries.
  const from = event.locations?.map((location) =>
    location.name === undefined ? location.id : `probe ${location.id}`
  );
  return from ? `${down} from ${from.join(", ")}` : down;
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

/**
 * The kinds of page a stranger's renders take turns between, so a flood of
 * one kind waits behind itself alone: `refresh`, a status page answer the
 * memo keeps (a view, document, badge, feed, summary or not-found) that went
 * stale, which a visitor is answered with while it refreshes; `cold`, one it
 * holds nothing for; `pages`, the pages everyone gets the same (sign-in,
 * forgot-password, sign-out, a reset or invitation page with no link, onboarding's language
 * and database screens); `subscriptions`, a subscription's page; `reset`, a
 * reset page whose link is open or an invitation page whose link is;
 * `onboarding`, onboarding's account screen
 * and a screen asked with another search; `others`, every other document.
 */
export type RenderLane =
  | "cold"
  | "onboarding"
  | "others"
  | "pages"
  | "refresh"
  | "reset"
  | "subscriptions";

/** The render pace's settings: the reads that check a made-up item before its not-found, one at a time with no gap, the renders, taking turns between their lanes, and how many of a stranger's requests carrying a body may be in flight before the next is answered 503 unread. */
export interface StrangerPace {
  readonly bodies: BodyLimits;
  readonly checks: PaceLimits<"checks">;
  readonly renders: PaceLimits<RenderLane>;
}

/**
 * The render pace, one table. Renders start half a second apart whatever
 * their lane: on a 256 MB Fly machine cycling every status page address, four
 * a second took its available memory from 118 to 51 MB and still falling, one
 * a second held it near 75 MB. A render there takes well under a second, so
 * five seconds is a wedged one, and two may run on past it.
 * A stranger's request carrying a body holds it, and the handler's state of
 * 15 to 20 KB beside it, until it is answered: 64 in flight, 16 from one
 * client network, held a 240 MB install against 4,000 slow bodies and 4,000
 * HTTP/2 streams, and a flood from one network leaves the others room.
 */
export const strangerPace: StrangerPace = {
  bodies: { perClient: 16, total: 64 },
  checks: {
    burst: 1,
    gapMs: 0,
    overrun: 2,
    turnMs: 5000,
    waiting: { checks: 32 },
  },
  renders: {
    burst: 60,
    gapMs: 500,
    overrun: 2,
    turnMs: 5000,
    waiting: {
      cold: 64,
      onboarding: 8,
      others: 8,
      pages: 16,
      refresh: 64,
      reset: 8,
      subscriptions: 32,
    },
  },
};

/** Bun's own idle timeout, when the entry is given none. */
const bunIdleSeconds = 10;

/** The largest body a request with no live session may carry: Start parses a server function's body, and Better Auth its JSON, before either asks who sent it, and a stranger's real ones (the subscribe form, sign-in, a reset) are a few kilobytes. Bounding one body bounds its parse; 200 at once held a 240 MB install. */
export const strangerBodyLimitBytes = 64 * 1024;

/** The largest body any other request may carry: a live session's, or one to an address that reads its body only after a live key (the management and probe APIs) or only its head (the heartbeat). A session's form has no largest: the monitor form's assertions take any number of texts of any length, and its capped fields alone come to 2,553,815 bytes with every character U+2028, which seroval and JSON write as 7 bytes. So it keeps the limit every request had before strangers had their own. */
export const bodyLimitBytes = 8 * 1024 * 1024;

/** A refused body's connection is kept, and Bun reads the rest of the body and drops it, so a proxy still streaming it gets the 413 rather than a broken pipe it answers 502. Until Bun has read it, the rest sits in the kernel's buffers, charged past the install's memory limit: 200 refused 1.1 MB bodies at once on kept connections took 77 to 91 MB. So a few a second keep their connection, and the rest, or one too large to be worth reading, close it. */
const keptRefusalsPerSecond = 4;
const keptRefusalLimitBytes = 64 * 1024 * 1024;

const keyedApi = /^\/api\/(v1|probe)\//;

/** The largest export an import takes. */
const uploadLimitBytes = 4 * 1024 ** 3;

/** Whether a request's body is refused before anything reads it: over its limit, or streamed with no length to judge; an import's upload streams in whole. Only a body past a stranger's limit asks `stranger`, so a stranger's small one costs no session read, and a forged cookie fails its signature before any. A body is judged by itself, not by transfer-encoding, which HTTP/2 never sends. */
async function oversized(
  request: Request,
  stranger: () => Promise<boolean>
): Promise<boolean> {
  const { pathname } = new URL(request.url);
  if (pathname === importPath) {
    return false;
  }
  const length = request.headers.get("content-length");
  if (length === null) {
    return request.body !== null;
  }
  const bytes = Number(length);
  if (bytes > bodyLimitBytes) {
    return true;
  }
  return (
    bytes > strangerBodyLimitBytes &&
    !keyedApi.test(pathname) &&
    !pathname.startsWith(heartbeatPathPrefix) &&
    (await stranger())
  );
}

/** The 413 for a body refused unread, its connection kept when `keep` has room and the body has a length worth reading. */
function refusedBody(request: Request, keep: () => boolean): Response {
  const length = request.headers.get("content-length");
  const kept =
    length !== null && Number(length) <= keptRefusalLimitBytes && keep();
  return new Response("Payload Too Large", {
    headers: kept ? {} : { connection: "close" },
    status: 413,
  });
}

/** How a request leaves the body budget: at once when it carries no body a stranger may send, read before anything asks who sent it (the import, the management API and the probe API read theirs only after a live session or key), or when it is a session's past the budget; a stranger's past the budget or its client's share is answered 503 unread. */
async function placeIn(
  bodies: BodyBudget,
  request: Request,
  stranger: () => Promise<boolean>
): Promise<(() => void) | Response> {
  const none = () => undefined;
  const { pathname } = new URL(request.url);
  if (
    request.body === null ||
    pathname === importPath ||
    keyedApi.test(pathname)
  ) {
    return none;
  }
  const place = bodies(
    clientNetwork(request.headers.get(clientAddressHeader) ?? "")
  );
  if (place) {
    return place;
  }
  return (await stranger()) ? busyAnswer() : none;
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
  idleTimeoutSeconds?: number,
  paceLimits: StrangerPace = strangerPace
): Bun.Server<undefined> {
  // A stranger's renders take turns, so a burst stays within what a small machine holds.
  const renders = createPace(paceLimits.renders);
  const idleSeconds = idleTimeoutSeconds ?? bunIdleSeconds;
  const checks = createPace(paceLimits.checks);
  // Refused bodies whose connection was kept this second.
  let keptSince = 0;
  let kept = 0;
  const keep = (): boolean => {
    const now = performance.now();
    if (now - keptSince >= 1000) {
      keptSince = now;
      kept = 0;
    }
    kept += 1;
    return kept <= keptRefusalsPerSecond;
  };
  const bodies = createBodyBudget(paceLimits.bodies);
  // An unpublished page shows its views to the signed-in operator alone.
  const memo = createPublicMemo({
    key: settings.installKey,
    now: Date.now,
    // A request that names no session cookie costs no session read.
    operator: async (request) =>
      carriesSession(request.headers) &&
      (await isOperator(
        holder.current,
        settings,
        request.headers,
        undefined,
        "read"
      )),
  });
  // Held in memory, read again only when the change counter moves.
  const proxies = heldTrustedProxies(settings.trustedProxies);
  const requestLog = heldRequestLog();
  const server: Bun.Server<undefined> = Bun.serve({
    development: false,
    fetch: async (request) => {
      const started = performance.now();
      const storage = holder.current;
      // A GET or HEAD reads the change counter once, for the memo, the trusted proxies and the request log switch; any other request keeps what the last one read.
      const counter =
        storage && (request.method === "GET" || request.method === "HEAD")
          ? memo.read(storage)
          : undefined;
      const trusted = await proxies(storage, await counter);
      const logging = await requestLog(storage, await counter);
      const resolved = withClientAddress(request, server, trusted);
      // A place in the body budget, held until answered or until a render or check of its own waits at the pace.
      let leaveBudget = (): void => undefined;
      const { checked, paced, stranger } = gatesFor(
        resolved,
        () => isOperator(holder.current, settings, resolved.headers),
        renders,
        checks,
        () => leaveBudget()
      );
      const entry = (await oversized(request, stranger))
        ? refusedBody(resolved, keep)
        : await placeIn(bodies, resolved, stranger);
      if (entry instanceof Response) {
        return logged(logging, resolved, entry, started);
      }
      leaveBudget = entry;
      // One render: a nonce of its own, named by its answer's policy, so a body the memo keeps is answered under the policy it was rendered for.
      const render = async (
        address: Request,
        publicTarget: PublicTarget | undefined,
        options: { readonly inlineCss?: false } = {}
      ): Promise<Response> => {
        const nonce = crypto.randomUUID();
        return withPolicy(
          await handler.fetch(address, {
            ...options,
            context: context(publicTarget, nonce),
          }),
          nonce
        );
      };
      const context = (
        publicTarget: PublicTarget | undefined,
        nonce: string
      ) => ({
        boot: settings,
        // The entry's own request: the one Bun's idle timer belongs to.
        holdOpen: (seconds: number) => server.timeout(request, seconds),
        missingView: () => memo.missing(resolved),
        nonce,
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
      // Whether a status page's answer was rendered for this request rather than served from the memo.
      let rendered = false;
      let memoised: Response | undefined;
      let response: Response;
      holdWhileWaiting(server, request);
      // A not-found the memo keeps still: its stylesheet linked, since the document is served at every address of its frame.
      const renderMissing: RenderMissing = (address, target, refresh) =>
        paced(
          visitorLane(refresh),
          async () => await render(address, target, { inlineCss: false })
        );
      try {
        // A try at a private page's password, posted to one of its views, is the memo's to judge.
        memoised =
          (await memo.attempt(resolved, storage, renderMissing, checked)) ??
          (await memo.answer(
            resolved,
            storage,
            (target, refresh) =>
              paced(visitorLane(refresh), async () => {
                rendered = true;
                return await render(viewRequest(resolved, refresh), target);
              }),
            counter,
            renderMissing,
            checked
          ));
        response =
          memoised ??
          (await memo.notFound(
            resolved,
            storage,
            renderMissing,
            counter,
            (pathname) => goneAt(storage, request.method, pathname)
          )) ??
          (await adminForStranger(resolved, storage, stranger)) ??
          (await memo.anonymous(
            resolved,
            storage,
            (address) =>
              paced("pages", async () => await render(address, undefined)),
            counter
          )) ??
          (await documentFor(
            resolved,
            { checked, paced, settings, storage },
            async () => await render(resolved, undefined)
          ));
      } catch (thrown) {
        if (logging) {
          logRequest(resolved, 500, started, undefined);
        }
        throw thrown;
      } finally {
        leaveBudget();
        // Answered: the connection's idle timer is Bun's own again, so a kept-alive socket closes as any other does.
        server.timeout(request, idleSeconds);
      }
      if (logging) {
        logRequest(
          resolved,
          response.status,
          started,
          memoAnswer(memoised, rendered)
        );
      }
      // The address the memo read with the change counter on this GET: no read of its own. A private page's answer is never framed, so no other site wraps its password form.
      return secured(
        response,
        memoised !== undefined && !privateAnswer(memoised),
        memo.publicAddress()
      );
    },
    hostname: settings.host,
    idleTimeout: idleTimeoutSeconds,
    // HTTP/2 to a client that opens with its preface, as a proxy with an HTTP/2 backend does (Fly's h2_backend); HTTP/1.1 to any other.
    http2: true,
    // An import streams its upload, so only Bun's own limit bounds it; every other body stops at its limit in `oversized`.
    maxRequestBodySize: uploadLimitBytes,
    port: settings.port,
    // With development false Bun sets SO_REUSEPORT unless told not to, and a
    // second raaqeb would share the port silently.
    reusePort: false,
    routes,
  });
  return server;
}

/** An HTML answer with the security headers, framable when it is a status page's view, with HSTS when the public address is https; any other answer as it is. */
function secured(
  response: Response,
  framable: boolean,
  publicAddress: string | undefined
): Response {
  if (!isHtml(response)) {
    return response;
  }
  return withSecurityHeaders(response, {
    framable,
    https: publicAddress?.startsWith("https:") ?? false,
  });
}

/** A request for a document, which may wait for a render, its own or one it joins, keeps its connection past Bun's idle timer; the entry gives the timer back once it is answered. So does one for an answer the memo keeps beside the views. Any other API call, a server function or the health check keeps Bun's timer, and asks for more itself when it needs it. */
function holdWhileWaiting(
  server: Pick<Bun.Server<undefined>, "timeout">,
  request: Request
): void {
  const { pathname } = new URL(request.url);
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    (rendersDocument(pathname) || memoResource.test(pathname))
  ) {
    server.timeout(request, 255);
  }
}

/** The answers the memo keeps beside the views: a view's document, a badge, a feed, a summary. */
const memoResource = /^\/api\/pages\/|\/(badge\.svg|feed\.atom|summary\.json)$/;

/** A status page answer's lane: a refresh of what the memo keeps, or an address it holds nothing for. */
function visitorLane(refresh: boolean): RenderLane {
  return refresh ? "refresh" : "cold";
}

/** The request a view renders through: a HEAD as a GET, so the stored entry has its body, and a refresh the visitor may not wait for with no signal of theirs to end it. */
function viewRequest(request: Request, refresh: boolean): Request {
  return refresh
    ? new Request(request.url, { headers: request.headers })
    : new Request(request, { method: "GET" });
}

/** A request's way through the render pace: whether it is a stranger's, read once and only when it names a session cookie, and its renders and checks paced if it is, leaving the body budget as they wait, since the pace bounds them; a session's run at once, and a render with no room is a 503. */
function gatesFor(
  request: Request,
  signedIn: () => Promise<boolean>,
  renders: Pace<RenderLane>,
  checks: Pace<"checks">,
  leaveBudget: () => void
) {
  let strangerRead: Promise<boolean> | undefined;
  const stranger = (): Promise<boolean> => {
    strangerRead ??= carriesSession(request.headers)
      ? signedIn().then((live) => !live)
      : Promise.resolve(true);
    return strangerRead;
  };
  return {
    checked: async (
      read: () => Promise<boolean>
    ): Promise<boolean | undefined> => {
      if (!(await stranger())) {
        return await read();
      }
      leaveBudget();
      return await checks.run("checks", read);
    },
    paced: async (
      lane: RenderLane,
      render: () => Promise<Response>
    ): Promise<Response> => {
      if (!(await stranger())) {
        return await render();
      }
      leaveBudget();
      return (await renders.run(lane, render)) ?? busyAnswer();
    },
    stranger,
  };
}

const resetPage = /^\/reset-password\/?$/;
const invitationPage = /^\/invitation\/?$/;

/** What the entry hands a document's render: the request's gates and what a reset link's check reads. */
interface DocumentGates {
  readonly checked: (
    read: () => Promise<boolean>
  ) => Promise<boolean | undefined>;
  readonly paced: (
    lane: RenderLane,
    render: () => Promise<Response>
  ) => Promise<Response>;
  readonly settings: BootSettings;
  readonly storage: Storage | undefined;
}

/** The lane a stranger's document renders in: a subscription's page, an onboarding screen, a reset link or an invitation that is open, every other one; the check tells an open link from one that is not. */
async function laneOf(url: URL, gates: DocumentGates): Promise<RenderLane> {
  if (subscriptionPage.test(url.pathname)) {
    return "subscriptions";
  }
  if (onboardingScreen.test(url.pathname)) {
    return "onboarding";
  }
  const token = url.searchParams.get("token");
  if (resetPage.test(url.pathname) && token) {
    const open = await gates.checked(() =>
      resetOpen(gates.storage, gates.settings, token)
    );
    return open ? "reset" : "others";
  }
  // An open invitation shares the open reset link's lane: both are one person's link, rare and short-lived.
  if (invitationPage.test(url.pathname) && token) {
    const open = await gates.checked(
      async () =>
        (await readInvitation(gates.storage, token.slice(0, 200), Date.now()))
          .ok
    );
    return open ? "reset" : "others";
  }
  return "others";
}

/** The app's answer to any other request: a document renders at its lane's pace, anything else at once. */
async function documentFor(
  request: Request,
  gates: DocumentGates,
  render: () => Promise<Response>
): Promise<Response> {
  const url = new URL(request.url);
  if (
    !(
      (request.method === "GET" || request.method === "HEAD") &&
      rendersDocument(url.pathname)
    )
  ) {
    return await render();
  }
  return await gates.paced(await laneOf(url, gates), render);
}

/** Whether a reset link is one the install would honour now; a read that fails says no, and the page renders as any other. */
async function resetOpen(
  storage: Storage | undefined,
  settings: BootSettings,
  token: string
): Promise<boolean> {
  if (!storage) {
    return false;
  }
  try {
    return await resetLinkOpen(
      await authFor(storage, settings),
      token,
      Date.now()
    );
  } catch {
    return false;
  }
}

/** An admin page, as the guard reads it; its import upload and history download are server routes with answers of their own. */
const adminPage = /^\/admin(\/.*)?$/i;
const adminServerRoute = /^\/admin\/import\/?$|\.jsonl\.zst$/i;

/** A stranger's admin page load, sent where the admin guard sends it without rendering anything: to onboarding until the account exists, then to sign-in; nothing for any other request. */
async function adminForStranger(
  request: Request,
  storage: Storage | undefined,
  stranger: () => Promise<boolean>
): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  if (
    !(
      (request.method === "GET" || request.method === "HEAD") &&
      adminPage.test(pathname)
    ) ||
    adminServerRoute.test(pathname) ||
    !(await stranger())
  ) {
    return;
  }
  const location =
    (await onboardingStep(storage)) === "done" ? "/sign-in" : "/onboarding";
  return new Response(null, { headers: { location }, status: 307 });
}

const onboardingScreen = /^\/onboarding(\/(account|database))?\/?$/;
const subscriptionPage = /^\/subscriptions\/([^/]+)\/?$/;

/** Whether a page an app route answers is a not-found to anyone who loads it: onboarding's screens once the account exists, and a subscription's page for a token no subscription has. A read that fails leaves the route to answer. */
async function goneAt(
  storage: Storage | undefined,
  method: string,
  pathname: string
): Promise<boolean> {
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }
  try {
    if (onboardingScreen.test(pathname)) {
      return (
        storage !== undefined && (await onboardingStep(storage)) === "done"
      );
    }
    const [, raw] = subscriptionPage.exec(pathname) ?? [];
    if (raw === undefined) {
      return false;
    }
    const token = subscriptionTokenSchema.safeParse(raw);
    return !(
      token.success &&
      storage &&
      (await subscriptionView(storage, token.data))
    );
  } catch {
    return false;
  }
}

/** How a status page's answer was made, or nothing when the memo did not answer. */
function memoAnswer(
  memoised: Response | undefined,
  rendered: boolean
): MemoAnswer | undefined {
  if (memoised === undefined) {
    return;
  }
  return rendered ? "rendered" : "cached";
}

/** A refusal made before the handler, with its line in the request log when the log is on. */
function logged(
  logging: boolean,
  request: Request,
  response: Response,
  started: number
): Response {
  if (logging) {
    logRequest(request, response.status, started, undefined);
  }
  return response;
}

/** Writes the request log's line for a request, timed from `started` to now; a request whose client left is named closed, whatever was answered. */
function logRequest(
  request: Request,
  status: number,
  started: number,
  memo: MemoAnswer | undefined
): void {
  const line = requestLine(
    request,
    request.signal.aborted ? closed : status,
    performance.now() - started,
    memo,
    process.memoryUsage.rss
  );
  if (line !== undefined) {
    logInfo(line);
  }
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
 * The policy of a render: scripts and style elements from this origin or
 * carrying the render's nonce, style attributes as React and Base UI write
 * them, and nothing else from elsewhere. A render that drew a status page
 * lets the page's custom CSS load fonts, images and stylesheets from any
 * https origin or a data URL; every other render, a route added later
 * included, loads them from its own origin alone.
 */
function contentSecurityPolicy(nonce: string, statusPage: boolean): string {
  const loaded = statusPage ? " https: data:" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'${statusPage ? " https:" : ""}`,
    "style-src-attr 'unsafe-inline'",
    ...(statusPage
      ? [`img-src 'self'${loaded}`, `font-src 'self'${loaded}`]
      : []),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** A rendered HTML answer with the policy naming its nonce, without the header that said it drew a status page; any other answer, or one that carries a policy of its own, as it is. */
function withPolicy(response: Response, nonce: string): Response {
  const statusPage = response.headers.has(statusPageHeader);
  const own =
    !isHtml(response) || response.headers.has("content-security-policy");
  if (own && !statusPage) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(statusPageHeader);
  if (!own) {
    headers.set(
      "content-security-policy",
      contentSecurityPolicy(nonce, statusPage)
    );
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * The headers every HTML response carries:
 * nosniff and the referrer policy always; frame-ancestors 'none' and
 * X-Frame-Options DENY unless the response is a status page's view, which a
 * site may embed, appended beside the render's own policy; HSTS only when
 * the stored public address is https.
 */
function withSecurityHeaders(
  response: Response,
  view: { readonly framable: boolean; readonly https: boolean }
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  if (!view.framable) {
    // Appended: a policy the response carries, such as a page image's sandbox, stays in force beside it.
    headers.append("content-security-policy", "frame-ancestors 'none'");
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

/** Whether an answer is a private page's, which only the visitor's own browser may keep. */
function privateAnswer(response: Response): boolean {
  return response.headers.get("cache-control")?.startsWith("private") ?? false;
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

/** What a long-running command hands back: `serve`'s server or a probe, either stopped by a signal. */
export interface Stoppable {
  readonly stop: () => Promise<void>;
}

/**
 * The binary's way in: `raaqeb probe` runs the probe, which opens no
 * database and loads no build; every other command is `main`.
 */
export async function runCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dir: string
): Promise<Stoppable | number> {
  const line = parseCommandLine(args);
  if (line.ok && line.command === "probe") {
    return probeCommand(env);
  }
  return await main(args, env, dir);
}

if (import.meta.main) {
  const result = await runCommand(
    Bun.argv.slice(2),
    process.env,
    ownBuildDir()
  );
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
