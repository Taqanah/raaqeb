import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import {
  currentVersion,
  type Fetch,
  newerRelease,
  readNewerRelease,
  refreshRelease,
  releaseCheckEnabled,
  releaseCheckResult,
  repository,
} from "./release.ts";

let open: { storage: Storage; cleanup: () => Promise<void> } | undefined;

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

const day = 86_400_000;
const at = 1_800_000_000_000;
const notes = "https://github.com/example/raaqeb/releases/tag/v1.2.0";
/** The public repository a release names once the constant is set. */
const named = "example/raaqeb";

/** A fake GitHub that records every request and answers what it is told to. */
function github(answer: () => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetch: Fetch = (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(answer());
  };
  return { fetch, requests };
}

function latest(tag: string): Response {
  return Response.json({ html_url: notes, tag_name: tag });
}

describe("the release check", () => {
  test("is on by default and asks the Releases API of the repository for the latest release", async () => {
    const store = await storage();
    const api = github(() => latest("v1.2.0"));
    await refreshRelease(store, {
      fetch: api.fetch,
      repository: named,
      now: () => at,
    });
    expect(api.requests).toHaveLength(1);
    const [request] = api.requests;
    expect(request?.url).toBe(
      `https://api.github.com/repos/${named}/releases/latest`
    );
    expect(request?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(request?.headers.get("user-agent")).toContain("raaqeb");
    expect(await store.settings.get(releaseCheckResult)).toEqual({
      checkedAt: at,
      latest: { url: notes, version: "1.2.0" },
    });
  });

  test("asks the public repository, Taqanah/raaqeb, when none is named", async () => {
    expect(repository).toBe("Taqanah/raaqeb");
    const store = await storage();
    const api = github(() => latest("v1.2.0"));
    await refreshRelease(store, { fetch: api.fetch, now: () => at });
    expect(api.requests.map((request) => request.url)).toEqual([
      "https://api.github.com/repos/Taqanah/raaqeb/releases/latest",
    ]);
  });

  test("runs at most once a day: a result younger than a day is kept, an older one is refreshed", async () => {
    const store = await storage();
    const api = github(() => latest("v1.2.0"));
    await refreshRelease(store, {
      fetch: api.fetch,
      repository: named,
      now: () => at,
    });
    await refreshRelease(store, {
      fetch: api.fetch,
      repository: named,
      now: () => at + day - 1,
    });
    expect(api.requests).toHaveLength(1);
    await refreshRelease(store, {
      fetch: api.fetch,
      repository: named,
      now: () => at + day,
    });
    expect(api.requests).toHaveLength(2);
  });

  test("switched off in settings, it never asks and the banner shows nothing even with a newer stored answer", async () => {
    const store = await storage();
    await store.settings.set(releaseCheckResult, {
      checkedAt: at,
      latest: { url: notes, version: "9.0.0" },
    });
    await store.settings.set(releaseCheckEnabled, false);
    const api = github(() => latest("v9.0.0"));
    await refreshRelease(store, {
      fetch: api.fetch,
      repository: named,
      now: () => at + day,
    });
    expect(api.requests).toHaveLength(0);
    expect(await readNewerRelease(store, "1.0.0")).toBeUndefined();
  });

  test("a 404 (no release yet, or the repository not public yet) stores the time only, so the next attempt waits a day", async () => {
    const store = await storage();
    // A release-shaped body with the failing status, so the status alone decides.
    const api = github(
      () =>
        new Response(JSON.stringify({ html_url: notes, tag_name: "v9.0.0" }), {
          headers: { "content-type": "application/json" },
          status: 404,
        })
    );
    await refreshRelease(store, {
      fetch: api.fetch,
      repository: named,
      now: () => at,
    });
    expect(await store.settings.get(releaseCheckResult)).toEqual({
      checkedAt: at,
    });
    await refreshRelease(store, {
      fetch: api.fetch,
      repository: named,
      now: () => at + 1,
    });
    expect(api.requests).toHaveLength(1);
  });

  test("a network failure or a body that is not a release does the same and never throws", async () => {
    const store = await storage();
    const failing = github(() => {
      throw new TypeError("fetch failed");
    });
    await refreshRelease(store, {
      fetch: failing.fetch,
      repository: named,
      now: () => at,
    });
    expect(await store.settings.get(releaseCheckResult)).toEqual({
      checkedAt: at,
    });
    const odd = github(() => Response.json({ message: "moved" }));
    await refreshRelease(store, {
      fetch: odd.fetch,
      repository: named,
      now: () => at + day,
    });
    expect(await store.settings.get(releaseCheckResult)).toEqual({
      checkedAt: at + day,
    });
  });

  test("a request that hangs is abandoned after the timeout and stores the time only", async () => {
    const store = await storage();
    const hanging: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    await refreshRelease(store, {
      fetch: hanging,
      now: () => at,
      repository: named,
      timeoutMs: 20,
    });
    expect(await store.settings.get(releaseCheckResult)).toEqual({
      checkedAt: at,
    });
  });

  test("two admin requests at once share one check", async () => {
    const store = await storage();
    const api = github(() => latest("v1.2.0"));
    await Promise.all([
      refreshRelease(store, {
        fetch: api.fetch,
        repository: named,
        now: () => at,
      }),
      refreshRelease(store, {
        fetch: api.fetch,
        repository: named,
        now: () => at,
      }),
    ]);
    expect(api.requests).toHaveLength(1);
  });

  test("a release whose link is not https stores the time only, so the banner never links to it", async () => {
    const store = await storage();
    for (const [index, link] of [
      "javascript:alert(document.cookie)",
      "http://github.com/example/raaqeb/releases/tag/v9.0.0",
    ].entries()) {
      const api = github(() =>
        Response.json({ html_url: link, tag_name: "v9.0.0" })
      );
      // biome-ignore lint/performance/noAwaitInLoops: one day after another
      await refreshRelease(store, {
        fetch: api.fetch,
        now: () => at + index * day,
        repository: named,
      });
      expect(await store.settings.get(releaseCheckResult)).toEqual({
        checkedAt: at + index * day,
      });
    }
    expect(await readNewerRelease(store, "1.0.0")).toBeUndefined();
  });

  test("a stored release whose link is not https shows no banner", async () => {
    const store = await storage();
    await store.settings.set(
      { key: releaseCheckResult.key, schema: z.unknown() },
      {
        checkedAt: at,
        latest: { url: "javascript:alert(1)", version: "9.0.0" },
      }
    );
    expect(await readNewerRelease(store, "1.0.0")).toBeUndefined();
  });

  test("a stored answer that no longer fits is refreshed rather than thrown", async () => {
    const store = await storage();
    await store.settings.set(
      { key: releaseCheckResult.key, schema: releaseCheckEnabled.schema },
      true
    );
    const api = github(() => latest("v1.2.0"));
    await refreshRelease(store, {
      fetch: api.fetch,
      repository: named,
      now: () => at,
    });
    expect(api.requests).toHaveLength(1);
    expect(await readNewerRelease(store, "1.0.0")).toEqual({
      url: notes,
      version: "1.2.0",
    });
  });
});

describe("what the banner shows", () => {
  test("the latest release when it is offered to the running build, and nothing when it is not", () => {
    const result = { checkedAt: at, latest: { url: notes, version: "1.2.0" } };
    expect(newerRelease(result, "1.1.9")).toEqual(result.latest);
    expect(newerRelease(result, "1.2.0")).toBeUndefined();
  });

  test("nothing before the first check, or when the check found nothing", () => {
    expect(newerRelease(undefined, "1.0.0")).toBeUndefined();
    expect(newerRelease({ checkedAt: at }, "1.0.0")).toBeUndefined();
  });

  test("the placeholder version counts every published release as newer, and a database that cannot answer shows no banner", async () => {
    expect(currentVersion).toBe("0.0.0");
    const store = await storage();
    await store.settings.set(releaseCheckResult, {
      checkedAt: at,
      latest: { url: notes, version: "0.1.0" },
    });
    expect(await readNewerRelease(store)).toEqual({
      url: notes,
      version: "0.1.0",
    });
    expect(
      await readNewerRelease({
        settings: {
          ...store.settings,
          get: () => Promise.reject(new Error("database gone")),
        },
      })
    ).toBeUndefined();
  });
});
