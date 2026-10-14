import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { inRanges } from "@/server/boot/proxies.ts";
import { openApiDocument } from "@/shared/api/openapi.ts";
import {
  checksums,
  compileArgs,
  imageLabels,
  imageTag,
  releaseVersion,
  targets,
} from "./package.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** The Caddyfile's on-demand check, the path it asks on Raaqeb. */
const askLine = /ask http:\/\/raaqeb:3000(\/\S+)/;

// The part of deploy/compose.yaml the trusted-proxy test reads.
const composeShape = z.object({
  networks: z.object({
    default: z.object({
      ipam: z.object({
        config: z.array(z.object({ ip_range: z.string(), subnet: z.string() })),
      }),
    }),
  }),
  services: z.object({
    caddy: z.object({
      networks: z.object({ default: z.object({ ipv4_address: z.string() }) }),
    }),
    raaqeb: z.object({
      environment: z.object({ RAAQEB_TRUSTED_PROXIES: z.string() }),
    }),
  }),
});

describe("the targets", () => {
  test("seven binaries: Linux x64 and arm64 each on glibc and on musl, macOS on Apple Silicon, Windows x64 and arm64", () => {
    expect(targets.map((target) => [target.bun, target.file])).toEqual([
      ["bun-linux-x64", "raaqeb-linux-x64"],
      ["bun-linux-arm64", "raaqeb-linux-arm64"],
      ["bun-linux-x64-musl", "raaqeb-linux-x64-musl"],
      ["bun-linux-arm64-musl", "raaqeb-linux-arm64-musl"],
      ["bun-darwin-arm64", "raaqeb-darwin-arm64"],
      ["bun-windows-x64", "raaqeb-windows-x64.exe"],
      ["bun-windows-arm64", "raaqeb-windows-arm64.exe"],
    ]);
  });

  test("the image carries the glibc binary of its platform, and no musl one", () => {
    expect(
      targets
        .filter((target) => target.platform !== undefined)
        .map((target) => [target.platform, target.file])
    ).toEqual([
      ["linux/amd64", "raaqeb-linux-x64"],
      ["linux/arm64", "raaqeb-linux-arm64"],
    ]);
  });
});

describe("compiling a binary", () => {
  test("every binary is compiled for production, so it carries React's production build and not its development one", () => {
    for (const target of targets) {
      expect(compileArgs(target, "out")).toContain(
        '--define=process.env.NODE_ENV="production"'
      );
    }
  });
});

describe("a minified binary", () => {
  test("every binary is minified", () => {
    for (const target of targets) {
      expect(compileArgs(target, "out")).toContain("--minify");
    }
  });
});

describe("the checksums file", () => {
  test("one line per file in name order, as sha256sum -c reads it", () => {
    expect(
      checksums([
        { bytes: bytes("b"), name: "raaqeb-linux-x64" },
        { bytes: bytes("a"), name: "raaqeb-linux-arm64" },
      ])
    ).toBe(
      [
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  raaqeb-linux-arm64",
        "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  raaqeb-linux-x64",
        "",
      ].join("\n")
    );
  });
});

describe("the image labels", () => {
  const build = {
    created: new Date(Date.UTC(2026, 8, 29, 8, 30)),
    dirty: false,
    revision: "e7fec3e0000000000000000000000000000000000",
    version: "0.1.0",
  };

  test("the OCI labels name the version, the commit, the time of the build, the license, the website and the source repository", () => {
    expect(imageLabels(build)).toEqual({
      "org.opencontainers.image.created": "2026-09-29T08:30:00.000Z",
      "org.opencontainers.image.description":
        "Self-hosted monitoring and status pages, Arabic first",
      "org.opencontainers.image.documentation": "https://raaqeb.dev/docs",
      "org.opencontainers.image.licenses": "FSL-1.1-ALv2",
      "org.opencontainers.image.revision":
        "e7fec3e0000000000000000000000000000000000",
      "org.opencontainers.image.source": "https://github.com/Taqanah/raaqeb",
      "org.opencontainers.image.title": "raaqeb",
      "org.opencontainers.image.url": "https://raaqeb.dev",
      "org.opencontainers.image.version": "0.1.0",
    });
  });

  test("the image is named in the GitHub registry under the organization, in lowercase, with the version as its tag", () => {
    expect(imageTag("0.1.0")).toBe("ghcr.io/taqanah/raaqeb:0.1.0");
  });

  test("a tree with changes is marked on the revision, so the image never claims a commit it does not match", () => {
    expect(
      imageLabels({ ...build, dirty: true })[
        "org.opencontainers.image.revision"
      ]
    ).toBe("e7fec3e0000000000000000000000000000000000-dirty");
  });
});

describe("the release version", () => {
  test("is package.json's version when it is a SemVer version, with or without a pre-release", () => {
    expect(releaseVersion({ name: "raaqeb", version: "0.1.0" })).toBe("0.1.0");
    expect(releaseVersion({ version: "12.0.3" })).toBe("12.0.3");
    for (const version of ["0.1.0-alpha.1", "0.1.0-beta.2", "0.1.0-rc.1"]) {
      expect(releaseVersion({ version })).toBe(version);
    }
  });

  test("a version the release check cannot compare is refused", () => {
    for (const pkg of [
      {},
      { version: "" },
      { version: "v0.1.0" },
      { version: "0.1" },
      { version: "0.1.0-" },
      { version: "0.1.0+build" },
      { version: 1 },
      "0.1.0",
      null,
    ]) {
      expect(() => releaseVersion(pkg)).toThrow(
        "package.json's version must be a SemVer version"
      );
    }
  });

  test("the repository's own package is a release version, and the operator compose file and the Fly sample run one stable release's image, never a pre-release", async () => {
    releaseVersion(await Bun.file(`${import.meta.dir}/../package.json`).json());
    const compose = await Bun.file(
      `${import.meta.dir}/../deploy/compose.yaml`
    ).text();
    const fly = await Bun.file(
      `${import.meta.dir}/../deploy/fly/fly.toml`
    ).text();
    const tag = compose.split("image: ")[1]?.split("\n")[0] ?? "";
    expect(tag).toStartWith(imageTag(""));
    expect(tag).not.toContain("-");
    expect(fly).toContain(`image = "${tag}"\n`);
  });
});

describe("the image and the compose file", () => {
  const repo = `${import.meta.dir}/..`;

  test("the Dockerfile makes /data private to the runtime user, so a fresh install logs no mode warning", async () => {
    const dockerfile = await Bun.file(`${repo}/Dockerfile`).text();
    expect(dockerfile).toContain(
      "--chown=65532:65532 --chmod=0700 /data /data\n"
    );
  });

  test("the Dockerfile copies each platform's glibc binary, and the build context lets exactly those in", async () => {
    const dockerfile = await Bun.file(`${repo}/Dockerfile`).text();
    const ignore = await Bun.file(`${repo}/.dockerignore`).text();
    const imaged = targets.filter((target) => target.platform !== undefined);
    for (const target of imaged) {
      const arch = target.platform?.split("/")[1];
      expect(dockerfile).toContain(
        `FROM scratch AS bin-${arch}\nCOPY dist/bin/${target.file} /raaqeb\n`
      );
    }
    expect(ignore.split("\n").filter((line) => line.startsWith("!"))).toEqual(
      imaged.map((target) => `!dist/bin/${target.file}`)
    );
  });

  test("the compose file believes forwarded headers from its Caddy only, at an address of its subnet no other service can be given", async () => {
    const compose = Bun.YAML.parse(
      await Bun.file(`${repo}/deploy/compose.yaml`).text()
    );
    const parsed = composeShape.parse(compose);
    const caddy = parsed.services.caddy.networks.default.ipv4_address;
    expect(parsed.services.raaqeb.environment.RAAQEB_TRUSTED_PROXIES).toBe(
      caddy
    );
    const [subnet] = parsed.networks.default.ipam.config;
    expect(inRanges([subnet?.subnet ?? ""])(caddy)).toBe(true);
    // Docker gives the other services addresses from ip_range, in any order.
    expect(inRanges([subnet?.ip_range ?? ""])(caddy)).toBe(false);
  });

  test("the compose file's Caddy issues a certificate on demand only once Raaqeb's custom domain route says yes", async () => {
    const caddyfile = await Bun.file(`${repo}/deploy/Caddyfile`).text();
    const ask = caddyfile.match(askLine)?.[1];
    expect(ask).toBe("/api/custom-domain");
    expect(Object.keys(openApiDocument().paths)).toContain(ask ?? "");
    expect(caddyfile).toContain("on_demand\n");
  });
});
