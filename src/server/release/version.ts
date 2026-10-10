/**
 * Release versions, SemVer with an optional pre-release: `1.2.3`, `1.2.3-alpha.1`,
 * `1.2.3-beta.2`, `1.2.3-rc.1`. The release check and the package script both
 * read them here.
 */

const number = "(?:0|[1-9]\\d*)";
const identifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
// SemVer 2.0.0 without build metadata; a missing minor or patch is read as zero.
const pattern = new RegExp(
  `^(${number})(?:\\.(${number}))?(?:\\.(${number}))?(?:-(${identifier}(?:\\.${identifier})*))?$`
);

/** Whether `text` is a full release version, three numbers and an optional pre-release. */
export function isVersion(text: string): boolean {
  return pattern.exec(text)?.[3] !== undefined;
}

/** The version with its missing parts filled in, or nothing when `text` is not one. */
function complete(
  text: string
): { preRelease: boolean; text: string } | undefined {
  const m = pattern.exec(text);
  if (!m) {
    return;
  }
  const [, major, minor = "0", patch = "0", pre] = m;
  return {
    preRelease: pre !== undefined,
    text: `${major}.${minor}.${patch}${pre === undefined ? "" : `-${pre}`}`,
  };
}

/**
 * Whether `published` should be offered to a build running `running`: it is
 * newer by SemVer order, and it is not a pre-release offered to a stable build.
 * A missing minor or patch reads as zero; text that is not a version is never newer.
 */
export function newerVersion(published: string, running: string): boolean {
  const latest = complete(published);
  const current = complete(running);
  if (!(latest && current) || (latest.preRelease && !current.preRelease)) {
    return false;
  }
  return Bun.semver.order(latest.text, current.text) === 1;
}
