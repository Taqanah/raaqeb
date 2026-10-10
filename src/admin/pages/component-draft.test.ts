import { describe, expect, test } from "bun:test";
import type { Component, LinkableMonitor } from "@/shared/schemas/component.ts";
import {
  componentDraftOf,
  componentInputOf,
  filterMonitors,
  withMonitor,
} from "./component-draft.ts";

const stored: Component = {
  createdAt: 1,
  description: { ar: "المتجر" },
  id: "c1",
  monitorIds: ["m1", "m2"],
  name: { ar: "الموقع", en: "Website" },
  status: "partial_outage",
  updatedAt: 2,
};

describe("the component form's draft", () => {
  test("a new component starts with no links, operational, and no name in any locale", () => {
    expect(componentDraftOf(undefined)).toEqual({
      description: { ar: "", en: "" },
      monitorIds: [],
      name: { ar: "", en: "" },
      status: "operational",
    });
  });

  test("a stored component's draft carries each locale's text as typed", () => {
    expect(componentDraftOf(stored)).toEqual({
      description: { ar: "المتجر", en: "" },
      monitorIds: ["m1", "m2"],
      name: { ar: "الموقع", en: "Website" },
      status: "partial_outage",
    });
  });

  test("the draft posts each locale's text, an empty one left out and an empty description as none", () => {
    expect(
      componentInputOf(
        {
          ...componentDraftOf(stored),
          description: { ar: "  ", en: "" },
          name: { ar: "الموقع", en: " " },
        },
        "ar"
      )
    ).toEqual({
      input: {
        description: undefined,
        monitorIds: ["m1", "m2"],
        name: { ar: "الموقع" },
        status: "partial_outage",
      },
      ok: true,
    });
  });

  test("the hand-set status is posted with links too, so it shows again once they go", () => {
    const parsed = componentInputOf(componentDraftOf(stored), "ar");
    expect(parsed.ok && parsed.input.status).toBe("partial_outage");
  });

  test("a name without the install language's text is refused with its message, whatever the other locale holds", () => {
    expect(
      componentInputOf(
        { ...componentDraftOf(undefined), name: { ar: " ", en: "Website" } },
        "ar"
      )
    ).toEqual({
      errors: { name: "component_missing_name" },
      ok: false,
    });
    const english = componentInputOf(
      { ...componentDraftOf(undefined), name: { ar: "", en: "Website" } },
      "en"
    );
    expect(english.ok && english.input.name).toEqual({ en: "Website" });
  });

  test("a description in the other locale alone is refused, since the install language's comes first", () => {
    expect(
      componentInputOf(
        { ...componentDraftOf(stored), description: { ar: "", en: "Shop" } },
        "ar"
      )
    ).toEqual({
      errors: { description: "component_missing_description" },
      ok: false,
    });
  });

  test("a name or a description past its limit in any locale is refused with its message", () => {
    expect(
      componentInputOf(
        {
          ...componentDraftOf(stored),
          description: { ar: "المتجر", en: "a".repeat(501) },
          name: { ar: "الموقع", en: "a".repeat(101) },
        },
        "ar"
      )
    ).toEqual({
      errors: {
        description: "component_refused_description",
        name: "component_refused_name",
      },
      ok: false,
    });
  });

  test("linking a monitor adds it once; unlinking takes it out", () => {
    const draft = componentDraftOf(stored);
    expect(withMonitor(draft, "m3", true).monitorIds).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(withMonitor(draft, "m1", true).monitorIds).toEqual(["m1", "m2"]);
    expect(withMonitor(draft, "m1", false).monitorIds).toEqual(["m2"]);
  });
});

describe("the monitor filter of the component form", () => {
  const monitors: LinkableMonitor[] = [
    {
      id: "a",
      name: "Shop API",
      paused: false,
      state: "up",
      target: "https://api.example.test/",
    },
    {
      id: "b",
      name: "قاعدة البيانات",
      paused: true,
      state: undefined,
      target: "db.example.test:5432",
    },
    {
      id: "c",
      name: "Nightly backup",
      paused: false,
      state: undefined,
      target: undefined,
    },
  ];

  test("no text keeps every monitor", () => {
    expect(filterMonitors(monitors, " ")).toEqual(monitors);
  });

  test("the text matches a name or a target, ignoring case", () => {
    expect(filterMonitors(monitors, "shop").map((m) => m.id)).toEqual(["a"]);
    expect(filterMonitors(monitors, "DB.EXAMPLE").map((m) => m.id)).toEqual([
      "b",
    ]);
    expect(filterMonitors(monitors, "البيانات").map((m) => m.id)).toEqual([
      "b",
    ]);
    expect(filterMonitors(monitors, "example").map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
  });
});
