import { describe, expect, test } from "bun:test";
import { z } from "zod";

// The workflows run only in the public repository, so nothing here can run them.
// These tests hold the rules that keep them safe to run unattended.
// The public-only files sit under public-root/ here and at the root of the public repository.
const overlay = `${import.meta.dir}/../public-root/.github/workflows`;
const folder = (await Bun.file(`${overlay}/release.yml`).exists())
  ? overlay
  : `${import.meta.dir}/../.github/workflows`;

const workflowShape = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      permissions: z.record(z.string(), z.string()).optional(),
    })
  ),
  on: z.unknown(),
  permissions: z.record(z.string(), z.string()),
});

async function load(name: "release" | "promote") {
  const text = await Bun.file(`${folder}/${name}.yml`).text();
  return { text, workflow: workflowShape.parse(Bun.YAML.parse(text)) };
}

const workflows = {
  promote: await load("promote"),
  release: await load("release"),
};
const loaded = Object.values(workflows);
const pinned = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(?:\.\d+)*$/;
const usesLine = /^\s*- uses: (.+)$/gm;
const secret = /secrets\.(\w+)/g;
const publishing = /gh release (?:edit|upload)/;
const byKey = (a: string, b: string) => a.localeCompare(b);

describe("the release workflows", () => {
  test("every action is pinned to a full commit with its version in a comment", () => {
    for (const { text } of loaded) {
      const uses = [...text.matchAll(usesLine)].map((m) => m[1]);
      expect(uses.length).toBeGreaterThan(0);
      for (const line of uses) {
        expect(line).toMatch(pinned);
      }
    }
  });

  test("the token can only read unless a job asks for more, and only the jobs that push or draft ask for write scopes", () => {
    const allowed: Record<string, string[]> = {
      image: ["contents", "packages", "id-token", "attestations"],
      promote: ["contents", "packages"],
      release: ["contents", "id-token", "attestations"],
    };
    for (const { workflow } of loaded) {
      expect(workflow.permissions).toEqual({ contents: "read" });
      for (const [job, { permissions }] of Object.entries(workflow.jobs)) {
        expect(Object.keys(permissions ?? {}).sort(byKey)).toEqual(
          (allowed[job] ?? []).sort(byKey)
        );
      }
    }
  });

  test("the workflow's own token is the only secret", () => {
    for (const { text } of loaded) {
      const used = new Set([...text.matchAll(secret)].map((m) => m[1]));
      expect([...used].filter((name) => name !== "GITHUB_TOKEN")).toEqual([]);
    }
  });

  test("a version tag starts the release, which drafts it and publishes nothing", () => {
    const { text, workflow } = workflows.release;
    expect(workflow.on).toEqual({ push: { tags: ["v*"] } });
    expect(text).toContain("gh release create");
    expect(text).toContain("--draft");
    expect(text).not.toMatch(publishing);
  });

  test("the image is pushed and the release drafted only after every platform's smoke test passed", () => {
    const { workflow } = workflows.release;
    expect(workflow.jobs.image?.needs).toEqual([
      "build",
      "smoke-mac",
      "smoke-windows",
    ]);
    expect(workflow.jobs.release?.needs).toEqual(["build", "image"]);
  });

  test("a published pre-release moves no image tag", () => {
    const { text } = workflows.promote;
    expect(text).toContain("!github.event.release.prerelease");
  });
});
