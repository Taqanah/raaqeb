import { describe, expect, test } from "bun:test";
import { messages as arabic } from "../../../locales/ar/messages.ts";
import { isPublicMessage, publicCatalog } from "./public.ts";

describe("the messages a status page's document inlines", () => {
  test("the public area, the status and impact levels and the two stage lists are public", () => {
    for (const id of [
      "public_banner_operational",
      "component_level_major_outage",
      "incident_impact_critical",
      "incident_stage_monitoring",
      "maintenance_stage_in_progress",
      "setting_theme_dark",
      "app_language",
    ]) {
      expect(isPublicMessage(id)).toBe(true);
    }
  });

  test("the error notice's words are, so a subscription page's failure speaks the catalog", () => {
    for (const id of [
      "app_error_title",
      "app_error_description",
      "app_try_again",
    ]) {
      expect(isPublicMessage(id)).toBe(true);
    }
  });

  test("the admin's words are not", () => {
    for (const id of [
      "monitor_status_up",
      "incident_column_impact",
      "component_status_now",
      "setting_time_zone",
      "app_save",
      "app_name",
      "channel_list_title",
    ]) {
      expect(isPublicMessage(id)).toBe(false);
    }
  });

  test("the public catalog keeps exactly the public messages, with their compiled text", () => {
    const picked = publicCatalog(arabic);
    const ids = Object.keys(picked);
    expect(ids.length).toBeGreaterThan(20);
    expect(ids.every(isPublicMessage)).toBe(true);
    expect(ids.length).toBe(Object.keys(arabic).filter(isPublicMessage).length);
    expect(picked.public_banner_operational).toEqual(
      arabic.public_banner_operational
    );
  });

  test("it is a small part of the whole catalog", () => {
    const whole = JSON.stringify(arabic).length;
    const part = JSON.stringify(publicCatalog(arabic)).length;
    expect(part * 10).toBeLessThan(whole);
  });
});

/** The source files a status page's document is built from: `src/public`, the view routes, and every file of `shared/` they import, however deep. */
async function publicSources(): Promise<string[]> {
  const scan = async (cwd: string) =>
    (await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd }))).map(
      (file) => `${cwd}/${file}`
    );
  const queue = [
    ...(await scan("src/public")),
    ...(await scan("src/routes/{-$locale}")),
    "src/routes/-public.ts",
  ].filter((file) => !file.includes(".test."));
  const seen = new Set<string>();
  for (const file of queue) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    // biome-ignore lint/performance/noAwaitInLoops: each file names the next ones
    const text = await Bun.file(file).text();
    for (const [, path = ""] of text.matchAll(
      /from "((?:@\/shared|\.)\/[^"]+\.tsx?)"/g
    )) {
      // The schemas drag in the admin's own words, and nothing a visitor reads.
      if (path.startsWith("@/shared/schemas/")) {
        continue;
      }
      queue.push(
        path.startsWith("@/")
          ? `src/${path.slice(2)}`
          : `${file.slice(0, file.lastIndexOf("/"))}/${path.slice(2)}`
      );
    }
  }
  return [...seen];
}

describe("the public page asks for public messages only", () => {
  test("every catalog id written in src/public, the view routes and the shared files they import is one the document inlines", async () => {
    const ids = new Set(Object.keys(arabic));
    const used: string[] = [];
    for (const file of await publicSources()) {
      // biome-ignore lint/performance/noAwaitInLoops: a handful of files, read in order
      const text = await Bun.file(file).text();
      for (const [, id = ""] of text.matchAll(/"([a-z]+_[a-z0-9_]+)"/g)) {
        if (ids.has(id)) {
          used.push(id);
        }
      }
    }
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((id) => !isPublicMessage(id))).toEqual([]);
  });
});
