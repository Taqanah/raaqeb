import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeConfigFile } from "@/server/boot/datadir.ts";
import { ChannelShapeError } from "@/server/storage/channels.ts";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import type { ChannelFields } from "@/shared/schemas/channel.ts";
import { publicAddress } from "./address.ts";
import { judgeSetup, readSetupChecks, type SetupFacts } from "./setup-check.ts";

/** A host's mount table: the root is a disk, not a container's overlay. */
const hostMounts = [
  "40 1 259:2 / / rw,noatime shared:1 - xfs /dev/nvme0n1p2 rw",
  "39 40 0:7 / /dev rw,nosuid shared:2 - devtmpfs devtmpfs rw",
].join("\n");

/** A container's mount table with no volume: the root is overlay. */
const containerMounts = [
  "612 548 0:52 / / rw,relatime master:310 - overlay overlay rw,lowerdir=/l,upperdir=/u,workdir=/w",
  "613 612 0:55 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
  "620 612 259:2 /etc/hosts /etc/hosts rw,noatime - xfs /dev/nvme0n1p2 rw",
].join("\n");

/** The same container with a named volume at /data. */
const volumeMounts = `${containerMounts}\n621 612 259:2 /var/lib/docker/volumes/raaqeb-data/_data /data rw,noatime - xfs /dev/nvme0n1p2 rw`;

/** The line of a volume Docker made without a name for the image's `VOLUME /data`, as `docker run` with no `-v` mounts it. */
const anonymousVolume = `622 612 259:2 /var/lib/docker/volumes/${"0123456789abcdef".repeat(4)}/_data /data rw,noatime - xfs /dev/nvme0n1p2 rw`;

/** Facts every check passes on. */
const sound: SetupFacts = {
  browserOrigin: "https://status.example.test",
  dataDir: { mode: 0o700, path: "/data", secrets: ["config.json"] },
  emailChannel: true,
  forwardedHeaders: ["x-forwarded-for", "x-forwarded-proto"],
  mountinfo: volumeMounts,
  peer: { address: "127.0.0.1", trusted: true },
  proxiesFrom: "setting",
  publicAddress: "https://status.example.test",
};

function checkOf<Name extends ReturnType<typeof judgeSetup>[number]["check"]>(
  facts: SetupFacts,
  name: Name
): Extract<ReturnType<typeof judgeSetup>[number], { check: Name }> | undefined {
  return judgeSetup(facts).find(
    (found): found is Extract<typeof found, { check: Name }> =>
      found.check === name
  );
}

describe("the setup checks on a sound install", () => {
  test("list every check in the page's order, each passing", () => {
    const checks = judgeSetup(sound);
    expect(checks.map((found) => found.check)).toEqual([
      "forwarded",
      "public_address",
      "email_channel",
      "data_directory_mode",
      "data_directory_volume",
    ]);
    expect(checks.every((found) => found.passed)).toBe(true);
  });
});

describe("the forwarded headers check", () => {
  test("forwarded headers from a peer that is not a trusted proxy fail, naming the peer and the headers", () => {
    expect(
      checkOf(
        {
          ...sound,
          forwardedHeaders: ["x-forwarded-proto"],
          peer: { address: "172.16.74.106", trusted: false },
        },
        "forwarded"
      )
    ).toEqual({
      check: "forwarded",
      headers: ["x-forwarded-proto"],
      passed: false,
      peer: "172.16.74.106",
      proxiesFrom: "setting",
      trusted: false,
    });
  });

  test("a request that reached Raaqeb directly, with no forwarded header, passes whatever its peer", () => {
    expect(
      checkOf(
        {
          ...sound,
          forwardedHeaders: [],
          peer: { address: "203.0.113.9", trusted: false },
        },
        "forwarded"
      )
    ).toMatchObject({
      headers: [],
      passed: true,
      peer: "203.0.113.9",
      trusted: false,
    });
  });

  test("a trusted proxy that adds no forwarded header passes as a trusted proxy, not as a direct request", () => {
    expect(
      checkOf({ ...sound, forwardedHeaders: [] }, "forwarded")
    ).toMatchObject({ headers: [], passed: true, trusted: true });
  });

  test("says whether the variable or the flag holds the trusted proxies, so the fix names the one in force", () => {
    for (const proxiesFrom of ["variable", "flag"] as const) {
      expect(
        checkOf(
          {
            ...sound,
            peer: { address: "172.16.74.106", trusted: false },
            proxiesFrom,
          },
          "forwarded"
        )
      ).toMatchObject({ passed: false, proxiesFrom });
    }
  });

  test("an unknown peer leaves the check out", () => {
    expect(checkOf({ ...sound, peer: undefined }, "forwarded")).toBeUndefined();
  });
});

describe("the public address check", () => {
  test("a public address on another origin than the browser's fails, naming both", () => {
    expect(
      checkOf(
        { ...sound, publicAddress: "http://status.example.test" },
        "public_address"
      )
    ).toEqual({
      browser: "https://status.example.test",
      check: "public_address",
      passed: false,
      stored: "http://status.example.test",
    });
  });

  test("no stored public address fails", () => {
    expect(
      checkOf({ ...sound, publicAddress: undefined }, "public_address")
    ).toMatchObject({ passed: false, stored: undefined });
  });

  test("the public address the browser is at passes", () => {
    expect(checkOf(sound, "public_address")).toMatchObject({
      passed: true,
      stored: "https://status.example.test",
    });
  });

  test("no Origin header, or one that is not an origin, leaves the check out", () => {
    expect(
      checkOf({ ...sound, browserOrigin: undefined }, "public_address")
    ).toBeUndefined();
    expect(
      checkOf({ ...sound, browserOrigin: "null" }, "public_address")
    ).toBeUndefined();
  });
});

describe("the email channel check", () => {
  test("no email channel fails, an email channel passes", () => {
    expect(checkOf({ ...sound, emailChannel: false }, "email_channel")).toEqual(
      { check: "email_channel", passed: false }
    );
    expect(checkOf(sound, "email_channel")?.passed).toBe(true);
  });

  test("a channel list that cannot be read leaves the check out", () => {
    expect(
      checkOf({ ...sound, emailChannel: undefined }, "email_channel")
    ).toBeUndefined();
  });
});

describe("the data directory mode check", () => {
  test("a data directory others can open fails while it holds secrets, naming them", () => {
    expect(
      checkOf(
        {
          ...sound,
          dataDir: {
            mode: 0o755,
            path: "/data",
            secrets: ["config.json", "raaqeb.sqlite"],
          },
        },
        "data_directory_mode"
      )
    ).toEqual({
      check: "data_directory_mode",
      mode: 0o755,
      onHostRoot: false,
      passed: false,
      path: "/data",
      secrets: ["config.json", "raaqeb.sqlite"],
    });
  });

  test("says chmod on the server reaches the directory only on the host's own root filesystem, or where the mount is unknown", () => {
    const onHostRoot = (mountinfo: string | undefined) =>
      checkOf({ ...sound, mountinfo }, "data_directory_mode")?.onHostRoot;
    expect(onHostRoot(hostMounts)).toBe(true);
    expect(onHostRoot(undefined)).toBe(true);
    expect(onHostRoot(volumeMounts)).toBe(false);
    expect(onHostRoot(containerMounts)).toBe(false);
  });

  test("the group's bits alone are enough to fail", () => {
    expect(
      checkOf(
        {
          ...sound,
          dataDir: { mode: 0o750, path: "/data", secrets: ["raaqeb.sqlite"] },
        },
        "data_directory_mode"
      )?.passed
    ).toBe(false);
  });

  test("a data directory others can open passes while nothing secret is in it", () => {
    expect(
      checkOf(
        { ...sound, dataDir: { mode: 0o755, path: "/data", secrets: [] } },
        "data_directory_mode"
      )
    ).toMatchObject({ mode: 0o755, passed: true, secrets: [] });
  });

  test("a data directory that cannot be read leaves both data directory checks out", () => {
    const checks = judgeSetup({ ...sound, dataDir: undefined });
    expect(checks.map((found) => found.check)).toEqual([
      "forwarded",
      "public_address",
      "email_channel",
    ]);
  });
});

describe("the data directory volume check", () => {
  test("a data directory on a container's overlay root, with no volume, fails", () => {
    expect(
      checkOf({ ...sound, mountinfo: containerMounts }, "data_directory_volume")
    ).toEqual({
      check: "data_directory_volume",
      mount: "container_root",
      passed: false,
      path: "/data",
    });
  });

  test("a rootless container's fuse-overlayfs root counts as an overlay root", () => {
    const rootless = containerMounts.replace(
      "- overlay overlay",
      "- fuse.fuse-overlayfs fuse-overlayfs"
    );
    expect(
      checkOf({ ...sound, mountinfo: rootless }, "data_directory_volume")
    ).toMatchObject({ mount: "container_root", passed: false });
  });

  test("a volume Docker made without a name for the image's VOLUME fails: a new container does not get it back", () => {
    expect(
      checkOf(
        { ...sound, mountinfo: `${containerMounts}\n${anonymousVolume}` },
        "data_directory_volume"
      )
    ).toEqual({
      check: "data_directory_volume",
      mount: "anonymous_volume",
      passed: false,
      path: "/data",
    });
  });

  test("a data directory in memory, on tmpfs or ramfs, fails: a reboot or a restart empties it", () => {
    const shots = {
      ...sound,
      dataDir: { mode: 0o700, path: "/tmp/shots", secrets: ["config.json"] },
    };
    for (const type of ["tmpfs", "ramfs"]) {
      expect(
        checkOf(
          {
            ...shots,
            mountinfo: `${hostMounts}\n50 40 0:40 / /tmp rw,nosuid shared:5 - ${type} ${type} rw`,
          },
          "data_directory_volume"
        )
      ).toEqual({
        check: "data_directory_volume",
        mount: "memory",
        passed: false,
        path: "/tmp/shots",
      });
    }
    expect(
      checkOf(
        {
          ...sound,
          mountinfo: `${containerMounts}\n650 612 0:70 / /data rw - tmpfs tmpfs rw`,
        },
        "data_directory_volume"
      )?.mount
    ).toBe("memory");
    expect(
      checkOf(
        {
          ...shots,
          dataDir: { mode: 0o700, path: "/tmp/shots", secrets: [] },
          mountinfo: `${hostMounts}\n50 40 0:40 / /tmp rw - tmpfs tmpfs rw`,
        },
        "data_directory_volume"
      )
    ).toBeUndefined();
  });

  test("a data directory with no secret file in it leaves the check out: nothing is lost with it", () => {
    expect(
      checkOf(
        {
          ...sound,
          dataDir: { mode: 0o700, path: "/data", secrets: [] },
          mountinfo: containerMounts,
        },
        "data_directory_volume"
      )
    ).toBeUndefined();
  });

  test("a volume mounted at the data directory, or above it, passes as a mount of its own", () => {
    expect(checkOf(sound, "data_directory_volume")).toMatchObject({
      mount: "own",
      passed: true,
    });
    expect(
      checkOf(
        {
          ...sound,
          dataDir: {
            mode: 0o700,
            path: "/data/raaqeb",
            secrets: ["config.json"],
          },
        },
        "data_directory_volume"
      )?.passed
    ).toBe(true);
  });

  test("a mount whose path only begins with the same letters is not above the data directory", () => {
    const beside = `${containerMounts}\n630 612 259:2 / /dat rw - xfs /dev/nvme0n1p2 rw`;
    expect(
      checkOf({ ...sound, mountinfo: beside }, "data_directory_volume")?.passed
    ).toBe(false);
  });

  test("a mount point with a space, escaped in the table, is read", () => {
    const spaced = `${containerMounts}\n631 612 259:2 / /srv/my\\040data rw - xfs /dev/nvme0n1p2 rw`;
    expect(
      checkOf(
        {
          ...sound,
          dataDir: {
            mode: 0o700,
            path: "/srv/my data",
            secrets: ["config.json"],
          },
          mountinfo: spaced,
        },
        "data_directory_volume"
      )?.passed
    ).toBe(true);
  });

  test("a data directory on a root filesystem that is no overlay leaves the check out: a host's disk and a VM's ephemeral one look alike", () => {
    expect(
      checkOf({ ...sound, mountinfo: hostMounts }, "data_directory_volume")
    ).toBeUndefined();
  });

  test("an overlay mounted below the root is not the container's root filesystem", () => {
    const below = `${hostMounts}\n700 40 0:60 / /srv/raaqeb rw - overlay overlay rw`;
    expect(
      checkOf(
        {
          ...sound,
          dataDir: {
            mode: 0o700,
            path: "/srv/raaqeb/data",
            secrets: ["config.json"],
          },
          mountinfo: below,
        },
        "data_directory_volume"
      )?.passed
    ).toBe(true);
  });

  test("of two mounts at one point, the later one is in force", () => {
    const named = volumeMounts.split("\n").at(-1);
    expect(
      checkOf(
        {
          ...sound,
          mountinfo: `${containerMounts}\n${anonymousVolume}\n${named}`,
        },
        "data_directory_volume"
      )?.passed
    ).toBe(true);
    expect(
      checkOf(
        { ...sound, mountinfo: `${volumeMounts}\n${anonymousVolume}` },
        "data_directory_volume"
      )?.passed
    ).toBe(false);
  });

  test("no mount table, or one with no mount above the data directory, leaves the check out", () => {
    expect(
      checkOf({ ...sound, mountinfo: undefined }, "data_directory_volume")
    ).toBeUndefined();
    expect(
      checkOf(
        { ...sound, mountinfo: "not a mount table" },
        "data_directory_volume"
      )
    ).toBeUndefined();
  });
});

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => Bun.$`rm -rf ${dir}`.quiet()));
});

async function scratchDir(): Promise<string> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  tempDirs.push(dir);
  return dir;
}

let open: { cleanup: () => Promise<void>; storage: Storage } | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = { cleanup: scratch.cleanup, storage: opened.storage };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

const mailer: ChannelFields = {
  appliesToNew: true,
  config: {},
  locale: undefined,
  name: "البريد",
  type: "email",
};

describe("the setup checks a request reads", () => {
  test("judge the browser's Origin, the forwarded headers by name, the stored public address and the channel list", async () => {
    const store = await storage();
    await store.settings.set(publicAddress, "http://status.example.test");
    await store.channels.create({ ...mailer, type: "webhook" });
    const checks = await readSetupChecks(
      store,
      { dataDir: await scratchDir(), trustedProxies: [] },
      {
        headers: new Headers({
          origin: "https://status.example.test",
          "x-forwarded-for": "198.51.100.1",
          "x-forwarded-proto": "https",
        }),
        peer: { address: "172.16.74.106", trusted: false },
      },
      "/nonexistent/mountinfo"
    );
    expect(checks.slice(0, 3)).toEqual([
      {
        check: "forwarded",
        headers: ["x-forwarded-for", "x-forwarded-proto"],
        passed: false,
        peer: "172.16.74.106",
        proxiesFrom: "setting",
        trusted: false,
      },
      {
        browser: "https://status.example.test",
        check: "public_address",
        passed: false,
        stored: "http://status.example.test",
      },
      { check: "email_channel", passed: false },
    ]);
  });

  test("an email channel among the channels passes, and the source of the boot's trusted proxies is named as the fix", async () => {
    const store = await storage();
    await store.channels.create(mailer);
    const dataDir = await scratchDir();
    const read = (trustedProxiesFrom: "variable" | "flag") =>
      readSetupChecks(
        store,
        { dataDir, trustedProxies: ["10.0.0.0/8"], trustedProxiesFrom },
        {
          headers: new Headers({ "x-forwarded-host": "status.example.test" }),
          peer: { address: "172.16.74.106", trusted: false },
        },
        "/nonexistent/mountinfo"
      );
    const [variable, flag] = await Promise.all([
      read("variable"),
      read("flag"),
    ]);
    expect(variable.find((found) => found.check === "email_channel")).toEqual({
      check: "email_channel",
      passed: true,
    });
    expect(variable.find((found) => found.check === "forwarded")).toMatchObject(
      {
        headers: ["x-forwarded-host"],
        proxiesFrom: "variable",
      }
    );
    expect(flag.find((found) => found.check === "forwarded")).toMatchObject({
      proxiesFrom: "flag",
    });
  });

  test("a channel list that throws, as a stored channel that no longer fits its schema does, leaves the email check out and the page answers", async () => {
    const store = await storage();
    const broken: Storage = {
      ...store,
      channels: {
        ...store.channels,
        list: () => Promise.reject(new ChannelShapeError("c1")),
      },
    };
    const checks = await readSetupChecks(
      broken,
      { dataDir: `${await scratchDir()}/gone`, trustedProxies: [] },
      { headers: new Headers(), peer: undefined },
      "/nonexistent/mountinfo"
    );
    expect(checks).toEqual([]);
  });

  test("judge the data directory by its real path, its mode and the secret files in it, and the mount table above it", async () => {
    const store = await storage();
    const real = `${await scratchDir()}/data`;
    await Bun.$`mkdir ${real} && chmod 755 ${real}`.quiet();
    await writeConfigFile(real, { installKey: "k" });
    const link = `${await scratchDir()}/link`;
    await Bun.$`ln -s ${real} ${link}`.quiet();
    const mountinfo = `${await scratchDir()}/mountinfo`;
    await Bun.write(mountinfo, containerMounts);
    const checks = await readSetupChecks(
      store,
      { dataDir: link, trustedProxies: [] },
      { headers: new Headers(), peer: undefined },
      mountinfo
    );
    expect(checks).toEqual([
      { check: "email_channel", passed: false },
      {
        check: "data_directory_mode",
        mode: 0o755,
        onHostRoot: false,
        passed: false,
        path: real,
        secrets: ["config.json"],
      },
      {
        check: "data_directory_volume",
        mount: "container_root",
        passed: false,
        path: real,
      },
    ]);
  });

  test("on Windows the data directory's checks are left out: it has no POSIX modes and no mount table", async () => {
    const store = await storage();
    const dataDir = `${await scratchDir()}/data`;
    await Bun.$`mkdir ${dataDir} && chmod 755 ${dataDir}`.quiet();
    await writeConfigFile(dataDir, { installKey: "k" });
    const mountinfo = `${await scratchDir()}/mountinfo`;
    await Bun.write(mountinfo, containerMounts);
    const checks = await readSetupChecks(
      store,
      { dataDir, trustedProxies: [] },
      { headers: new Headers(), peer: undefined },
      mountinfo,
      "win32"
    );
    expect(checks).toEqual([{ check: "email_channel", passed: false }]);
  });

  test("a data directory that is gone and an unreadable mount table leave their checks out", async () => {
    const store = await storage();
    const checks = await readSetupChecks(
      store,
      { dataDir: `${await scratchDir()}/gone`, trustedProxies: [] },
      { headers: new Headers(), peer: undefined },
      "/nonexistent/mountinfo"
    );
    expect(checks).toEqual([{ check: "email_channel", passed: false }]);
  });
});
