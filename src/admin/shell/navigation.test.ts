import { describe, expect, test } from "bun:test";
import type { MonitorChoice } from "@/shared/schemas/monitor.ts";
import { navigation, type PaletteItem, paletteGroups } from "./navigation.ts";

describe("the sidebar's grouped navigation", () => {
  test("holds the screens under groups, every one under /admin", () => {
    const paths = navigation.flatMap((group) =>
      group.items.map((item) => item.to)
    );
    expect(paths).toContain("/admin/monitors");
    expect(paths).toContain("/admin/pages");
    expect(paths).toContain("/admin/components");
    expect(paths).toContain("/admin/incidents");
    expect(paths).toContain("/admin/maintenance");
    expect(paths).toContain("/admin/channels");
    expect(paths).toContain("/admin/settings");
    expect(paths.every((path) => path.startsWith("/admin/"))).toBe(true);
    expect(navigation.length).toBeGreaterThan(1);
  });
});

describe("the command palette's contents", () => {
  test("offers every page of the navigation, then the actions: new monitor, the shortcut sheet, sign out", () => {
    const groups = paletteGroups("", [], "ar");
    const items = groups.flatMap((group) => group.items);
    const pages = items.flatMap((item) =>
      item.kind === "page" ? [item.item.to] : []
    );
    const actions = items.flatMap((item) =>
      item.kind === "action" ? [item.action] : []
    );
    for (const group of navigation) {
      for (const item of group.items) {
        expect(pages).toContain(item.to);
      }
    }
    expect(actions).toEqual(["new_monitor", "shortcuts", "sign_out"]);
    // A settings page the sidebar does not list, offered beside settings.
    expect(pages).toContain("/admin/settings/setup-check");
    expect(groups.at(-1)?.items.every((item) => item.kind === "action")).toBe(
      true
    );
  });

  const monitors: readonly MonitorChoice[] = [
    { id: "m1", name: "واجهة البرمجة", target: "https://api.example.test/" },
    { id: "m2", name: "Billing API", target: "billing.example.test:443" },
    { id: "m3", name: "Nightly backup", target: undefined },
    { id: "m4", name: "api gateway", target: "https://gw.example.test/" },
  ];

  /** What a query offers beyond the pages and the actions, in order: a monitor by its id, the list searched as `search:<query>`. */
  function found(query: string, locale = "en"): string[] {
    return paletteGroups(query, monitors, locale)
      .flatMap((group) => group.items)
      .flatMap((item: PaletteItem) => {
        if (item.kind === "monitor") {
          return [item.monitor.id];
        }
        return item.kind === "search" ? [`search:${item.query}`] : [];
      });
  }

  test("with no query, offers no monitor and no search of the list, whatever monitors exist", () => {
    expect(found("")).toEqual([]);
    expect(found("   ")).toEqual([]);
  });

  test("a query finds the monitors whose name or target holds it, whatever the case, as the list's search does", () => {
    expect(found("API")).toEqual(["m4", "m2", "m1", "search:API"]);
    expect(found("billing.example")).toEqual(["m2", "search:billing.example"]);
    expect(found("واجهة")).toEqual(["m1", "search:واجهة"]);
  });

  test("the monitors found are sorted by name under the locale, as the list sorts them", () => {
    expect(found("a", "en")).toEqual(["m4", "m2", "m3", "m1", "search:a"]);
    // Arabic collation puts the Arabic script first, so the locale must reach the sort.
    expect(found("a", "ar")).toEqual(["m1", "m4", "m2", "m3", "search:a"]);
  });

  test("a query no monitor matches still offers the list searched for it", () => {
    expect(found("nothing like this")).toEqual(["search:nothing like this"]);
  });

  test("the list searched carries the query without its surrounding spaces", () => {
    expect(found("  backup ")).toEqual(["m3", "search:backup"]);
  });

  test("the monitors found and the list searched sit after the pages and before the actions, every group and item under its own key", () => {
    const groups = paletteGroups("api", monitors, "en");
    const kinds = groups.map((group) => group.items[0]?.kind);
    expect(kinds.slice(0, navigation.length)).toEqual(
      navigation.map(() => "page")
    );
    expect(groups[navigation.length]?.items.map((item) => item.kind)).toEqual([
      "monitor",
      "monitor",
      "monitor",
      "search",
    ]);
    expect(groups.at(-1)?.items.every((item) => item.kind === "action")).toBe(
      true
    );
    const keys = groups.flatMap((group) => [
      group.id,
      ...group.items.map((item) =>
        item.kind === "page" ? item.item.id : item.id
      ),
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
