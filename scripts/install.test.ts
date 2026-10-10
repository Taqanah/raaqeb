import { afterEach, describe, expect, test } from "bun:test";
import { checksums, targets } from "./package.ts";

// deploy/install.sh, its parts called one
// at a time from sh with the last line, `main "$@"`, left off; the whole
// install runs in containers under `bun run install:check`.
const scriptPath = `${import.meta.dir}/../deploy/install.sh`;
const script = await Bun.file(scriptPath).text();
const library = script.replace(/\nmain "\$@"\n$/, "\n");

let scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.map((dir) => Bun.$`rm -rf ${dir}`.quiet()));
  scratch = [];
});

async function scratchDir(): Promise<string> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  scratch.push(dir);
  return dir;
}

interface Ran {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function ran(command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, stdout } satisfies Ran;
}

/** One line of sh run after the installer's functions are defined. */
function call(line: string, env: Record<string, string> = {}): Promise<Ran> {
  return ran(["sh", "-c", `${library}\n${line}`], env);
}

/** The text's `key=value` lines, each key with every value it is given, in order. */
function settingsOf(text: string): Map<string, string[]> {
  const settings = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && !line.startsWith("#")) {
      const key = line.slice(0, at).trim();
      settings.set(key, [...(settings.get(key) ?? []), line.slice(at + 1)]);
    }
  }
  return settings;
}

test("the parts are called without running the install", () => {
  expect(library).not.toBe(script);
});

describe("which binary a machine gets", () => {
  test("x86_64 and aarch64 map onto the x64 and arm64 binaries, on glibc and on musl", async () => {
    for (const [machine, libc, target] of [
      ["x86_64", "glibc", "x64"],
      ["x86_64", "musl", "x64-musl"],
      ["aarch64", "glibc", "arm64"],
      ["aarch64", "musl", "arm64-musl"],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one machine at a time
      const answer = await call(`target_of ${machine} ${libc}`);
      expect(answer.stdout.trim()).toBe(target ?? "");
      expect(targets.map((each) => each.file)).toContain(
        `raaqeb-linux-${target}`
      );
    }
  });

  test("a machine Raaqeb builds no binary for is refused by name", async () => {
    for (const machine of ["armv7l", "i686", "riscv64"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one machine at a time
      const answer = await call(`target_of ${machine} glibc`);
      expect(answer.code).toBe(1);
      expect(answer.stdout).toBe("");
      expect(answer.stderr).toContain(machine);
    }
  });

  /** A root whose /usr/bin/ldd prints `version` as a C library's ldd does. */
  async function withLdd(version: string, loaders: string[]) {
    const root = await scratchDir();
    for (const loader of loaders) {
      // biome-ignore lint/performance/noAwaitInLoops: a few files, one after another
      await Bun.write(`${root}${loader}`, "");
    }
    await Bun.write(
      `${root}/usr/bin/ldd`,
      `#!/bin/sh\nprintf '%s\\n' '${version}' >&2\n`
    );
    await Bun.$`chmod 0755 ${root}/usr/bin/ldd`;
    return root;
  }

  test("musl is told by the system's own ldd, glibc otherwise", async () => {
    const musl = await withLdd("musl libc (x86_64)", [
      "/lib/ld-musl-x86_64.so.1",
    ]);
    expect((await call(`libc_of ${musl}`)).stdout.trim()).toBe("musl");
    const glibc = await withLdd("ldd (Debian GLIBC 2.41-12) 2.41", [
      "/lib64/ld-linux-x86-64.so.2",
    ]);
    expect((await call(`libc_of ${glibc}`)).stdout.trim()).toBe("glibc");
    const bare = await scratchDir();
    expect((await call(`libc_of ${bare}`)).stdout.trim()).toBe("glibc");
  });

  test("a glibc system with the musl package installed still gets the glibc binary, and Alpine with gcompat the musl one", async () => {
    const debian = await withLdd("ldd (Debian GLIBC 2.41-12) 2.41", [
      "/lib/ld-musl-x86_64.so.1",
      "/lib64/ld-linux-x86-64.so.2",
    ]);
    expect((await call(`libc_of ${debian}`)).stdout.trim()).toBe("glibc");
    const alpine = await withLdd("musl libc (x86_64)", [
      "/lib/ld-musl-x86_64.so.1",
      "/lib/ld-linux-x86-64.so.2",
    ]);
    expect((await call(`libc_of ${alpine}`)).stdout.trim()).toBe("musl");
  });
});

describe("which binary a Mac gets", () => {
  test("Apple Silicon gets the arm64 binary, one the release builds", async () => {
    const answer = await call("darwin_file arm64 0");
    expect(answer.stdout.trim()).toBe("raaqeb-darwin-arm64");
    expect(targets.map((each) => each.file)).toContain("raaqeb-darwin-arm64");
  });

  test("an Apple Silicon Mac whose shell runs under Rosetta, which reads as x86_64, still gets the arm64 binary", async () => {
    const answer = await call("darwin_file x86_64 1");
    expect(answer.stdout.trim()).toBe("raaqeb-darwin-arm64");
  });

  test("an Intel Mac is refused, naming Apple Silicon", async () => {
    const answer = await call("darwin_file x86_64 0");
    expect(answer.code).toBe(1);
    expect(answer.stdout).toBe("");
    expect(answer.stderr).toContain("Apple Silicon");
  });
});

describe("the _raaqeb user on a Mac", () => {
  test("takes the first id from 300 that no user and no group holds", async () => {
    const answer = await call(
      "printf '%s\\n' 'root 0' '_www 70' 'a 300' 'b 301' '_g 302' 'c 304' | free_id"
    );
    expect(answer.stdout.trim()).toBe("303");
  });

  test("finds none when every id from 300 below 500 is held", async () => {
    const answer = await call(
      "awk 'BEGIN { for (id = 300; id < 500; id++) print \"u \" id }' | free_id"
    );
    expect(answer.code).not.toBe(0);
    expect(answer.stdout).toBe("");
  });
});

describe("which service the install writes", () => {
  test("systemd when it runs, OpenRC when it runs, none otherwise", async () => {
    const systemd = await scratchDir();
    await Bun.$`mkdir -p ${systemd}/run/systemd/system`;
    expect((await call(`init_of ${systemd}`)).stdout.trim()).toBe("systemd");

    const openrc = await scratchDir();
    await Bun.write(`${openrc}/run/openrc/softlevel`, "default");
    expect((await call(`init_of ${openrc}`)).stdout.trim()).toBe("openrc");

    const bare = await scratchDir();
    expect((await call(`init_of ${bare}`)).stdout.trim()).toBe("none");
  });

  test("OpenRC installed but not running is no init system, so the manual start is printed", async () => {
    const installed = await scratchDir();
    await Bun.write(`${installed}/sbin/openrc-run`, "#!/bin/sh\n");
    await Bun.$`chmod 0755 ${installed}/sbin/openrc-run`;
    expect((await call(`init_of ${installed}`)).stdout.trim()).toBe("none");
  });

  test("a running systemd wins over an OpenRC runner left on disk", async () => {
    const both = await scratchDir();
    await Bun.$`mkdir -p ${both}/run/systemd/system`;
    await Bun.write(`${both}/sbin/openrc-run`, "#!/bin/sh\n");
    await Bun.$`chmod 0755 ${both}/sbin/openrc-run`;
    expect((await call(`init_of ${both}`)).stdout.trim()).toBe("systemd");
  });
});

describe("the checksum", () => {
  async function release(binary: string) {
    const dir = await scratchDir();
    const files = [
      { bytes: new TextEncoder().encode(binary), name: "raaqeb-linux-x64" },
      {
        bytes: new TextEncoder().encode("musl"),
        name: "raaqeb-linux-x64-musl",
      },
    ];
    await Bun.write(`${dir}/SHA256SUMS`, checksums(files));
    return dir;
  }

  test("a binary that matches SHA256SUMS passes", async () => {
    const dir = await release("the binary");
    await Bun.write(`${dir}/raaqeb-linux-x64`, "the binary");
    expect((await call(`verify ${dir} raaqeb-linux-x64`)).code).toBe(0);
  });

  test("a binary that does not match is refused, naming it", async () => {
    const dir = await release("the binary");
    await Bun.write(`${dir}/raaqeb-linux-x64`, "another binary");
    const answer = await call(`verify ${dir} raaqeb-linux-x64`);
    expect(answer.code).toBe(1);
    expect(answer.stderr).toContain("raaqeb-linux-x64");
  });

  test("a name that only begins another's line is not listed: the glibc binary never passes on the musl binary's sum", async () => {
    const dir = await scratchDir();
    await Bun.write(
      `${dir}/SHA256SUMS`,
      checksums([
        {
          bytes: new TextEncoder().encode("the binary"),
          name: "raaqeb-linux-x64-musl",
        },
      ])
    );
    await Bun.write(`${dir}/raaqeb-linux-x64`, "the binary");
    const answer = await call(`verify ${dir} raaqeb-linux-x64`);
    expect(answer.code).toBe(1);
    expect(answer.stderr).toContain("lists no raaqeb-linux-x64");
  });

  test("a binary SHA256SUMS does not list is refused, never passed unchecked", async () => {
    const dir = await release("the binary");
    await Bun.write(`${dir}/raaqeb-linux-arm64`, "unlisted");
    const answer = await call(`verify ${dir} raaqeb-linux-arm64`);
    expect(answer.code).toBe(1);
    expect(answer.stderr).toContain("raaqeb-linux-arm64");
  });
});

describe("the checksum on a Mac", () => {
  // macOS has shasum, a Perl script, and no sha256sum.
  test.skipIf(Bun.which("shasum") === null)(
    "is read with shasum where there is no sha256sum, and still refuses a binary that does not match",
    async () => {
      const bin = await scratchDir();
      for (const tool of ["grep", "shasum"]) {
        // biome-ignore lint/performance/noAwaitInLoops: two links, one after another
        await Bun.$`ln -s ${Bun.which(tool) ?? ""} ${bin}/${tool}`;
      }
      const dir = await scratchDir();
      await Bun.write(
        `${dir}/SHA256SUMS`,
        checksums([
          {
            bytes: new TextEncoder().encode("the binary"),
            name: "raaqeb-darwin-arm64",
          },
        ])
      );
      const check = () =>
        ran(
          ["/bin/sh", "-c", `${library}\nverify ${dir} raaqeb-darwin-arm64`],
          {
            PATH: bin,
          }
        );
      await Bun.write(`${dir}/raaqeb-darwin-arm64`, "the binary");
      expect((await check()).code).toBe(0);
      await Bun.write(`${dir}/raaqeb-darwin-arm64`, "another binary");
      const refused = await check();
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("raaqeb-darwin-arm64");
    }
  );
});

describe("the systemd unit", () => {
  async function unit() {
    return settingsOf((await call("unit_text")).stdout);
  }

  test("runs the binary's serve as the raaqeb user, started again on failure", async () => {
    const settings = await unit();
    expect(settings.get("ExecStart")).toEqual(["/usr/local/bin/raaqeb serve"]);
    expect(settings.get("User")).toEqual(["raaqeb"]);
    expect(settings.get("Group")).toEqual(["raaqeb"]);
    expect(settings.get("Restart")).toEqual(["on-failure"]);
    expect(settings.get("WantedBy")).toEqual(["multi-user.target"]);
  });

  test("keeps its data in /var/lib/raaqeb and listens on localhost, the env file read after so it may change either", async () => {
    const text = (await call("unit_text")).stdout;
    const settings = settingsOf(text);
    expect(settings.get("Environment")).toEqual([
      "RAAQEB_DATA_DIR=/var/lib/raaqeb RAAQEB_HOST=127.0.0.1 RAAQEB_PORT=3000",
    ]);
    expect(settings.get("EnvironmentFile")).toEqual([
      "-/etc/raaqeb/raaqeb.env",
    ]);
    expect(text.indexOf("EnvironmentFile=")).toBeGreaterThan(
      text.indexOf("Environment=")
    );
  });

  test("is hardened: no privileges, a read-only system but the data directory, no devices, kernel or capabilities", async () => {
    const settings = await unit();
    for (const [key, value] of [
      ["NoNewPrivileges", "yes"],
      ["ProtectSystem", "strict"],
      ["ReadWritePaths", "/var/lib/raaqeb"],
      ["ProtectHome", "yes"],
      ["PrivateTmp", "yes"],
      ["PrivateDevices", "yes"],
      ["ProtectKernelTunables", "yes"],
      ["ProtectKernelModules", "yes"],
      ["ProtectKernelLogs", "yes"],
      ["ProtectControlGroups", "yes"],
      ["ProtectClock", "yes"],
      ["ProtectHostname", "yes"],
      ["ProtectProc", "invisible"],
      ["ProcSubset", "pid"],
      ["RestrictAddressFamilies", "AF_INET AF_INET6 AF_UNIX"],
      ["RestrictNamespaces", "yes"],
      ["RestrictRealtime", "yes"],
      ["RestrictSUIDSGID", "yes"],
      ["LockPersonality", "yes"],
      ["SystemCallArchitectures", "native"],
      ["SystemCallFilter", "@system-service"],
      ["CapabilityBoundingSet", ""],
      ["AmbientCapabilities", ""],
      ["UMask", "0077"],
    ]) {
      expect(settings.get(key ?? ""), key).toEqual([value ?? ""]);
    }
  });

  test("leaves memory that is written and then run allowed, which Bun's JIT compiler needs", async () => {
    expect((await unit()).has("MemoryDenyWriteExecute")).toBe(false);
  });
});

describe("the OpenRC service", () => {
  test("runs the binary's serve as the raaqeb user under supervise-daemon, started again when it stops", async () => {
    const settings = settingsOf((await call("openrc_text")).stdout);
    expect(settings.get("supervisor")).toEqual(["supervise-daemon"]);
    expect(settings.get("command")).toEqual(["/usr/local/bin/raaqeb"]);
    expect(settings.get("command_args")).toEqual(["serve"]);
    expect(settings.get("command_user")).toEqual(["raaqeb:raaqeb"]);
    expect(settings.get("respawn_delay")).toBeDefined();
  });

  test("reads the env file at its top level, after its own values, so a line set there wins", async () => {
    const text = (await call("openrc_text")).stdout;
    const own = text.indexOf("export RAAQEB_DATA_DIR=");
    const env = text.indexOf(". /etc/raaqeb/raaqeb.env");
    expect(own).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(own);
    expect(env).toBeLessThan(text.indexOf("depend()"));
  });

  test("logs into a folder the raaqeb user owns, since supervise-daemon opens the log as that user", async () => {
    const text = (await call("openrc_text")).stdout;
    const settings = settingsOf(text);
    expect(settings.get("output_log")).toEqual(["/var/log/raaqeb/raaqeb.log"]);
    expect(settings.get("error_log")).toEqual(["/var/log/raaqeb/raaqeb.log"]);
    expect(text).toContain(
      "checkpath --directory --owner raaqeb:raaqeb --mode 0750 /var/log/raaqeb"
    );
  });

  test("keeps its data in /var/lib/raaqeb, listens on localhost, and reads the env file", async () => {
    const text = (await call("openrc_text")).stdout;
    expect(text).toContain("RAAQEB_DATA_DIR=/var/lib/raaqeb");
    expect(text).toContain("RAAQEB_HOST=127.0.0.1");
    expect(text).toContain("/etc/raaqeb/raaqeb.env");
  });
});

/** The shell line the launchd daemon runs. */
const launchCommand = /<string>(export RAAQEB_DATA_DIR=[^<]*)<\/string>/;

describe("the launchd daemon", () => {
  async function plist() {
    return (await call("plist_text")).stdout;
  }

  /** The value element after a key, as launchd reads the plist. */
  function plistValue(text: string, key: string): string | undefined {
    return new RegExp(
      `<key>${key}</key>\\s*(<[^>]+/>|<(\\w+)>[\\s\\S]*?</\\2>)`
    ).exec(text)?.[1];
  }

  test("runs serve as the _raaqeb user from boot, started again when it exits with a failure", async () => {
    const text = await plist();
    expect(plistValue(text, "Label")).toBe("<string>raaqeb</string>");
    expect(plistValue(text, "UserName")).toBe("<string>_raaqeb</string>");
    expect(plistValue(text, "GroupName")).toBe("<string>_raaqeb</string>");
    expect(plistValue(text, "RunAtLoad")).toBe("<true/>");
    expect(plistValue(text, "KeepAlive")?.replace(/\s/g, "")).toBe(
      "<dict><key>SuccessfulExit</key><false/></dict>"
    );
    // 0077, which launchd takes as a decimal integer.
    expect(plistValue(text, "Umask")).toBe("<integer>63</integer>");
  });

  test("keeps its data in /usr/local/var/raaqeb and listens on localhost, the env file read after so it may change either", async () => {
    const text = await plist();
    const command = launchCommand.exec(text)?.[1];
    expect(command).toBeDefined();
    const own = command?.indexOf(
      "export RAAQEB_DATA_DIR=/usr/local/var/raaqeb RAAQEB_HOST=127.0.0.1 RAAQEB_PORT=3000"
    );
    const env = command?.indexOf(". /usr/local/etc/raaqeb/raaqeb.env") ?? -1;
    const serve = command?.indexOf("exec /usr/local/bin/raaqeb serve") ?? -1;
    expect(own).toBe(0);
    expect(env).toBeGreaterThan(0);
    expect(serve).toBeGreaterThan(env);
  });

  test("logs into a folder the _raaqeb user owns", async () => {
    const text = await plist();
    expect(plistValue(text, "StandardOutPath")).toBe(
      "<string>/usr/local/var/log/raaqeb/raaqeb.log</string>"
    );
    expect(plistValue(text, "StandardErrorPath")).toBe(
      "<string>/usr/local/var/log/raaqeb/raaqeb.log</string>"
    );
  });
});

describe("the Windows installer", () => {
  const windows = Bun.file(`${import.meta.dir}/../deploy/install.ps1`);

  test("names only binaries the release builds", async () => {
    const text = await windows.text();
    expect(text).toContain("raaqeb-windows-$arch.exe");
    for (const arch of ["x64", "arm64"]) {
      expect(text).toContain(`'${arch}'`);
      expect(targets.map((each) => each.file)).toContain(
        `raaqeb-windows-${arch}.exe`
      );
    }
  });

  test("without RAAQEB_DOWNLOAD_URL it reads the latest release's tag from the redirect of the releases address, not followed, or takes RAAQEB_VERSION as v<version>, and downloads both files from that release", async () => {
    const text = await windows.text();
    expect(text).toContain("https://github.com/Taqanah/raaqeb/releases");
    expect(text).toContain("/latest");
    expect(text).toContain("AllowAutoRedirect = $false");
    expect(text).toContain("/releases/tag/");
    expect(text).toContain("$env:RAAQEB_VERSION");
    expect(text).toContain("/download/$tag");
    expect(text).not.toContain("api.github.com");
  });

  test("an address in RAAQEB_DOWNLOAD_URL wins over the version and the latest release, and the installer no longer refuses to run without it", async () => {
    const text = await windows.text();
    expect(text).toContain("$env:RAAQEB_DOWNLOAD_URL");
    expect(text).not.toContain("set $env:RAAQEB_DOWNLOAD_URL to the folder");
  });

  test("says a repository with no release, an unreachable GitHub and a version that is not a release apart", async () => {
    const text = await windows.text();
    expect(text).toContain("has no release yet");
    expect(text).toContain("could not reach");
    expect(text).toContain("a release of Raaqeb");
  });

  test("checks the binary against SHA256SUMS before it installs it", async () => {
    const text = await windows.text();
    expect(text).toContain("SHA256SUMS");
    expect(text).toContain("Get-FileHash");
  });

  test("runs the binary itself as Local Service, never stopped for running long, started again within a minute of stopping", async () => {
    const text = await windows.text();
    // Local Service by its SID, whose name Windows translates.
    expect(text).toContain("S-1-5-19");
    expect(text).toContain("New-ScheduledTaskAction -Execute $bin");
    expect(text).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
    expect(text).toContain("-MultipleInstances IgnoreNew");
    expect(text).toContain("-RepetitionInterval (New-TimeSpan -Minutes 1)");
    expect(text).toContain("-AtStartup");
  });

  test("opens its folder under ProgramData, which holds the data directory, to Local Service, SYSTEM and the Administrators alone, and Local Service reads the folder and the env file and writes only in the data directory, so it cannot change its own boot settings", async () => {
    const text = await windows.text();
    expect(text).toContain(
      "icacls $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX'"
    );
    expect(text).toContain("icacls $data /grant '*S-1-5-19:(OI)(CI)M'");
    expect(text).not.toContain("'*S-1-5-19:(OI)(CI)M' '");
  });

  test("refuses a folder another account made before the install, whose files cannot be trusted, and gives a trusted one to the Administrators with every child reset to the folder's list", async () => {
    const text = await windows.text();
    for (const trusted of ["S-1-5-32-544", "S-1-5-18"]) {
      expect(text).toContain(`'${trusted}'`);
    }
    expect(text).toContain("cannot be trusted");
    expect(text).toContain("icacls $root /setowner '*S-1-5-32-544' /T /C");
    expect(text).toContain("/reset /T /C");
  });

  test("runs Raaqeb at normal priority, not Task Scheduler's below-normal default", async () => {
    expect(await windows.text()).toContain("-Priority 4");
  });

  test("an upgrade whose copy fails starts the task it stopped again before it fails", async () => {
    const text = await windows.text();
    const copy = text.indexOf("Copy-Item -LiteralPath (Join-Path $tmp $file)");
    const enable = text.indexOf("Enable-ScheduledTask", copy);
    expect(copy).toBeGreaterThan(-1);
    expect(enable).toBeGreaterThan(copy);
    expect(text.indexOf("Start-ScheduledTask", enable)).toBeGreaterThan(enable);
  });
});

/** A shell or PowerShell comment at the end of a line. */
const trailingComment = /\s+#.*$/;

describe("the smoke tests' uninstall", () => {
  const guide = Bun.file(
    `${import.meta.dir}/../website/content/docs/operate/uninstall.en.mdx`
  );

  /** The command lines of the guide's first code block after a heading line, comments cut. */
  async function guideLines(after: string): Promise<string[]> {
    const text = await guide.text();
    const block = text.slice(text.indexOf(after)).split("```")[1] ?? "";
    return block
      .split("\n")
      .slice(1)
      .map((line) => line.replace(trailingComment, "").trim())
      .filter((line) => line !== "");
  }

  test("on Windows runs the guide's own lines, the wait for the process among them", async () => {
    const lines = await guideLines(
      "On Windows, in PowerShell as Administrator:"
    );
    expect(lines.some((line) => line.includes("Wait-Process"))).toBe(true);
    const smoke = await Bun.file(`${import.meta.dir}/smoke-windows.ps1`).text();
    for (const line of lines) {
      expect(smoke, line).toContain(line);
    }
  });

  test("on a Mac runs the guide's own lines", async () => {
    const lines = await guideLines("On a Mac, as root:");
    expect(lines.length).toBeGreaterThan(0);
    const smoke = await Bun.file(`${import.meta.dir}/smoke-mac.sh`).text();
    for (const line of lines) {
      expect(smoke, line).toContain(line);
    }
  });
});

describe("the env file the install writes once", () => {
  test("sets nothing: every line is a comment, so the unit's own values hold until the operator writes one", async () => {
    const text = (await call("env_text")).stdout;
    expect(text.length).toBeGreaterThan(0);
    for (const line of text.split("\n")) {
      expect(line === "" || line.startsWith("#"), line).toBe(true);
    }
  });

  test("names each boot setting the operator may set there", async () => {
    const text = (await call("env_text")).stdout;
    for (const name of [
      "RAAQEB_HOST",
      "RAAQEB_PORT",
      "RAAQEB_TRUSTED_PROXIES",
      "RAAQEB_SECRET_KEY",
      "DATABASE_URL",
      "BETTER_AUTH_SECRETS",
    ]) {
      expect(text).toContain(name);
    }
  });
});

/** A stand-in for GitHub's releases address: it answers `/latest` as told and records every path asked. */
function releases(latest: () => Response) {
  const asked: string[] = [];
  const server = Bun.serve({
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      asked.push(pathname);
      return pathname === "/releases/latest"
        ? latest()
        : new Response("Not found", { status: 404 });
    },
    port: 0,
  });
  return {
    address: `http://127.0.0.1:${server.port}/releases`,
    asked,
    stop: () => server.stop(true),
  };
}

const redirectTo = (tag: string) => (): Response =>
  new Response(null, {
    headers: { location: `/releases/tag/${tag}` },
    status: 302,
  });

describe("where the install downloads from", () => {
  let stands: { stop: () => void }[] = [];
  afterEach(() => {
    for (const each of stands) {
      each.stop();
    }
    stands = [];
  });
  function stand(latest: () => Response) {
    const made = releases(latest);
    stands.push(made);
    return made;
  }

  test("with no address and no version it is the latest release's folder, read from the redirect of /releases/latest without following it", async () => {
    const github = stand(redirectTo("v0.2.0"));
    const answer = await call(`download_url ${github.address}`);
    expect(answer.stdout.trim()).toBe(`${github.address}/download/v0.2.0`);
    expect(github.asked).toEqual(["/releases/latest"]);
  });

  test("a version names its release's folder as v<version>, and GitHub is not asked", async () => {
    const github = stand(redirectTo("v9.9.9"));
    const answer = await call(`download_url ${github.address}`, {
      RAAQEB_VERSION: "0.2.0-beta.1",
    });
    expect(answer.stdout.trim()).toBe(
      `${github.address}/download/v0.2.0-beta.1`
    );
    expect(github.asked).toEqual([]);
  });

  test("a version written with its v names the same release", async () => {
    const answer = await call("download_url http://example.test/releases", {
      RAAQEB_VERSION: "v0.2.0",
    });
    expect(answer.stdout.trim()).toBe(
      "http://example.test/releases/download/v0.2.0"
    );
  });

  test("an address wins over a version and over the latest release, a trailing slash dropped, and GitHub is not asked", async () => {
    const github = stand(redirectTo("v0.2.0"));
    const answer = await call(`download_url ${github.address}`, {
      RAAQEB_DOWNLOAD_URL: "file:///root/bin/",
      RAAQEB_VERSION: "0.3.0",
    });
    expect(answer.stdout.trim()).toBe("file:///root/bin");
    expect(github.asked).toEqual([]);
  });

  test("a version that is not a version is refused before it reaches an address", async () => {
    for (const version of ["v", "../x", "1.0 0", "1.0/../../x", "-o"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one version at a time
      const answer = await call("download_url http://example.test/releases", {
        RAAQEB_VERSION: version,
      });
      expect(answer.code).toBe(1);
      expect(answer.stdout).toBe("");
      expect(answer.stderr).toContain("RAAQEB_VERSION");
    }
  });

  test("a repository with no release yet, where /latest answers the releases list or 404, says there is none and names the two variables", async () => {
    for (const latest of [
      () =>
        new Response(null, { headers: { location: "/releases" }, status: 302 }),
      () =>
        new Response(null, {
          headers: { location: "/releases/tag/" },
          status: 302,
        }),
      () => new Response("Not found", { status: 404 }),
    ]) {
      const github = stand(latest);
      // biome-ignore lint/performance/noAwaitInLoops: one answer at a time
      const answer = await call(`download_url ${github.address}`);
      expect(answer.code).toBe(1);
      expect(answer.stdout).toBe("");
      expect(answer.stderr).toContain("no release");
      expect(answer.stderr).toContain("RAAQEB_VERSION");
      expect(answer.stderr).toContain("RAAQEB_DOWNLOAD_URL");
    }
  });

  test("no network says GitHub could not be reached, not that there is no release", async () => {
    const answer = await call("download_url http://127.0.0.1:1/releases");
    expect(answer.code).toBe(1);
    expect(answer.stderr).toContain("could not reach");
    expect(answer.stderr).not.toContain("no release");
  });

  test("a download that fails for a named version says that version may not exist", async () => {
    const github = stand(redirectTo("v0.2.0"));
    const folder = await scratchDir();
    const answer = await call(
      `fetch ${github.address}/download/v9.9.9/SHA256SUMS ${folder}/SHA256SUMS "no release v9.9.9?"`
    );
    expect(answer.code).toBe(1);
    expect(answer.stderr).toContain("could not download");
    expect(answer.stderr).toContain("no release v9.9.9?");
  });
});

describe("the install's refusals", () => {
  test.skipIf(process.getuid?.() === 0)(
    "run by anyone but root it asks for root before downloading anything",
    async () => {
      const answer = await ran(["sh", scriptPath], {
        RAAQEB_DOWNLOAD_URL: "http://127.0.0.1:1/",
      });
      expect(answer.code).toBe(1);
      expect(answer.stderr).toContain("root");
    }
  );
});
