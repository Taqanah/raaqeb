/**
 * `raaqeb probe` (CONTEXT.md "Probe"): reads where to report and the token
 * from the environment, then runs the probe until a signal stops it. Exit
 * code 2 is an environment the probe cannot run with.
 */
import { liveIo } from "@/server/checks/io.ts";
import { error as logError, info as logInfo } from "@/server/log.ts";
import { currentVersion } from "@/server/release/release.ts";
import { createProbe, type ProbeProcess, probeTarget } from "./probe.ts";

export function probeCommand(
  env: Readonly<Record<string, string | undefined>>
): ProbeProcess | number {
  const target = probeTarget(env);
  if (!target.ok) {
    logError(target.message);
    return 2;
  }
  const probe = createProbe({
    fetch,
    io: liveIo(),
    log: logError,
    monotonic: () => performance.now(),
    server: target.server,
    token: target.token,
    version: currentVersion,
  });
  probe.start();
  logInfo("probing for the install at RAAQEB_PROBE_SERVER");
  return probe;
}
