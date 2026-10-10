/**
 * The setup checks (CONTEXT.md "Setup check"): `judgeSetup` is the pure
 * rules over facts handed in; `readSetupChecks` gathers those facts from what
 * the server already holds, the request, the settings, the channel list, the
 * data directory and the mount table, with no outbound call and no write.
 */

import { inspectDataDir } from "@/server/boot/datadir.ts";
import type { Peer } from "@/server/boot/proxies.ts";
import type { BootSettings } from "@/server/boot/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { isOrigin } from "@/shared/schemas/address.ts";
import type {
  ProxiesSource,
  SetupCheck,
} from "@/shared/schemas/setup-check.ts";
import { readPublicAddress } from "./address.ts";

/** What the rules judge. An absent fact leaves its check out: it could not be known. */
export interface SetupFacts {
  /** The origin in the request's `Origin` header, as the browser sent it; nothing when it sent none. */
  readonly browserOrigin: string | undefined;
  /** The data directory as it stands; nothing when it cannot be read. */
  readonly dataDir:
    | {
        /** Its real, absolute path. */
        readonly path: string;
        readonly mode: number;
        readonly secrets: readonly string[];
      }
    | undefined;
  /** Whether an email channel exists; nothing when the channel list cannot be read. */
  readonly emailChannel: boolean | undefined;
  /** The `X-Forwarded-*` headers the request carries, by name. */
  readonly forwardedHeaders: readonly string[];
  /** `/proc/self/mountinfo`; nothing off Linux or when it cannot be read. */
  readonly mountinfo: string | undefined;
  /** The socket peer and whether it is a trusted proxy; nothing when the peer is unknown. */
  readonly peer: Peer | undefined;
  /** Where the trusted proxies in force come from. */
  readonly proxiesFrom: ProxiesSource;
  readonly publicAddress: string | undefined;
}

/** The headers a proxy adds, which Raaqeb believes only from a trusted proxy. */
const forwardedNames = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
] as const;

/** Every check the facts can answer, in the page's order. */
export function judgeSetup(facts: SetupFacts): SetupCheck[] {
  const checks: SetupCheck[] = [];
  if (facts.peer) {
    checks.push({
      check: "forwarded",
      headers: facts.forwardedHeaders,
      passed: facts.forwardedHeaders.length === 0 || facts.peer.trusted,
      peer: facts.peer.address,
      proxiesFrom: facts.proxiesFrom,
      trusted: facts.peer.trusted,
    });
  }
  const browser = facts.browserOrigin;
  if (browser !== undefined && isOrigin(browser)) {
    // Both are serialised origins, so text equality is origin equality, as Better Auth compares them.
    checks.push({
      browser,
      check: "public_address",
      passed: facts.publicAddress === browser,
      stored: facts.publicAddress,
    });
  }
  if (facts.emailChannel !== undefined) {
    checks.push({ check: "email_channel", passed: facts.emailChannel });
  }
  const { dataDir } = facts;
  if (!dataDir) {
    return checks;
  }
  const mount =
    facts.mountinfo === undefined
      ? undefined
      : mountOf(facts.mountinfo, dataDir.path);
  // The low two octal digits are the group's and others' bits.
  const open = dataDir.mode % 0o100 !== 0;
  checks.push({
    check: "data_directory_mode",
    mode: dataDir.mode,
    onHostRoot: mount === undefined || mount === "host_root",
    passed: !open || dataDir.secrets.length === 0,
    path: dataDir.path,
    secrets: dataDir.secrets,
  });
  // A host's disk and a VM's ephemeral root look alike, and a directory with no secret loses nothing: no verdict for either.
  if (dataDir.secrets.length > 0 && mount && mount !== "host_root") {
    checks.push({
      check: "data_directory_volume",
      mount,
      passed: mount === "own",
      path: dataDir.path,
    });
  }
  return checks;
}

/** A container's root filesystem: Docker's overlay, or rootless Docker's and Podman's FUSE one. */
const overlayTypes = new Set(["overlay", "fuse.fuse-overlayfs"]);

/** Filesystems in memory, which a reboot, or a container's restart, empties. */
const memoryTypes = new Set(["tmpfs", "ramfs"]);

/** Where Docker and Podman keep a volume made without a name, named by 64 hex digits. */
const anonymousVolume = /\/volumes\/[0-9a-f]{64}\/_data$/;

/** What the data directory is mounted on; nothing when the table has no mount above it. */
function mountOf(
  mountinfo: string,
  path: string
):
  | "host_root"
  | "container_root"
  | "anonymous_volume"
  | "memory"
  | "own"
  | undefined {
  const found = mountAbove(mountinfo, path);
  if (!found) {
    return;
  }
  if (memoryTypes.has(found.type)) {
    return "memory";
  }
  if (found.point === "/") {
    return overlayTypes.has(found.type) ? "container_root" : "host_root";
  }
  return anonymousVolume.test(found.root) ? "anonymous_volume" : "own";
}

/** A space, a tab, a newline or a backslash in a mount point, which the kernel writes in octal. */
const escaped = /\\([0-7]{3})/g;

/** The mount a path lives on, from a table in `/proc/self/mountinfo`'s format: the deepest mount point above it, the later of two at one point, with the path inside its source it shows; nothing when no line is one. */
function mountAbove(
  mountinfo: string,
  path: string
): { point: string; root: string; type: string } | undefined {
  let found: { point: string; root: string; type: string } | undefined;
  for (const line of mountinfo.split("\n")) {
    // id, parent, device, root, mount point, options, optional fields, "-", type, source, options.
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    const [, , , root, raw] = fields;
    const type = fields[separator + 1];
    if (
      separator < 6 ||
      root === undefined ||
      raw === undefined ||
      type === undefined
    ) {
      continue;
    }
    const point = unescaped(raw);
    const above =
      point === "/" || path === point || path.startsWith(`${point}/`);
    if (above && point.length >= (found?.point.length ?? 0)) {
      found = { point, root: unescaped(root), type };
    }
  }
  return found;
}

function unescaped(field: string): string {
  return field.replace(escaped, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  );
}

/** Gathers the facts for one request and judges them. On Windows the data directory is left out: it has no POSIX modes, and the mount table is Linux's. */
export async function readSetupChecks(
  storage: Pick<Storage, "channels" | "settings">,
  boot: Pick<BootSettings, "dataDir" | "trustedProxies" | "trustedProxiesFrom">,
  request: { readonly headers: Headers; readonly peer: Peer | undefined },
  mountinfoPath = "/proc/self/mountinfo",
  platform: NodeJS.Platform = process.platform
): Promise<SetupCheck[]> {
  const { headers } = request;
  const [channels, stored, dataDir, mountinfo] = await Promise.all([
    // A stored channel that no longer fits its schema throws; the email check then cannot know.
    storage.channels.list().catch(() => undefined),
    readPublicAddress(storage),
    platform === "win32"
      ? undefined
      : inspectDataDir(boot.dataDir).catch(() => undefined),
    Bun.file(mountinfoPath)
      .text()
      .catch(() => undefined),
  ]);
  return judgeSetup({
    browserOrigin: headers.get("origin") ?? undefined,
    dataDir,
    emailChannel: channels?.some((channel) => channel.type === "email"),
    forwardedHeaders: forwardedNames.filter((name) => headers.has(name)),
    mountinfo,
    peer: request.peer,
    proxiesFrom:
      boot.trustedProxies.length === 0
        ? "setting"
        : (boot.trustedProxiesFrom ?? "variable"),
    publicAddress: stored,
  });
}
