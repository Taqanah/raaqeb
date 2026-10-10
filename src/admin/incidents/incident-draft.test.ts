import { describe, expect, test } from "bun:test";
import type { Incident, NewIncident } from "@/shared/schemas/incident.ts";
import {
  fieldsDraftOf,
  fieldsInputOf,
  fixInputOf,
  impactFor,
  newIncidentDraftOf,
  newIncidentInputOf,
  updateDraftOf,
  updateInputOf,
  withoutComponent,
  withStatus,
} from "./incident-draft.ts";

const t0 = 1_700_000_000_000;

const blank: NewIncident = { components: [], prefill: undefined };

/** Nothing typed in any locale. */
const none = { ar: "", en: "" };

/** Text typed in Arabic alone. */
const arabic = (text: string) => ({ ar: text, en: "" });

const stored: Incident = {
  createdAt: t0,
  id: "i",
  impact: "major",
  resolvedAt: undefined,
  title: { ar: "بطء في الدفع", en: "Slow checkout" },
  updatedAt: t0,
  updates: [
    {
      author: "owner@example.com",
      createdAt: t0,
      id: "u1",
      message: { ar: "نحقق." },
      stage: "investigating",
      statuses: [{ componentId: "web", status: "major_outage" }],
    },
    {
      author: "owner@example.com",
      createdAt: t0 + 60_000,
      id: "u2",
      message: { ar: "عرفنا السبب." },
      stage: "identified",
      statuses: [
        { componentId: "web", status: "partial_outage" },
        { componentId: "api", status: "degraded_performance" },
      ],
    },
  ],
};

describe("the impact level a status suggests", () => {
  test("it reads the summary's mapping backwards", () => {
    expect(impactFor("operational")).toBe("none");
    expect(impactFor("under_maintenance")).toBe("none");
    expect(impactFor("degraded_performance")).toBe("minor");
    expect(impactFor("partial_outage")).toBe("major");
    expect(impactFor("major_outage")).toBe("critical");
  });
});

describe("the new incident's draft", () => {
  test("a blank one is investigating, affects nothing, has no impact and no text in any locale", () => {
    expect(newIncidentDraftOf(blank, "ar")).toEqual({
      impact: "none",
      message: none,
      stage: "investigating",
      statuses: [],
      title: none,
    });
  });

  test("one from a monitor's link carries its title in the install language and its components, and the impact their worst status suggests", () => {
    expect(
      newIncidentDraftOf(
        {
          components: [],
          prefill: {
            statuses: [
              { componentId: "web", status: "partial_outage" },
              { componentId: "api", status: "major_outage" },
            ],
            title: "Payment gateway",
          },
        },
        "en"
      )
    ).toEqual({
      impact: "critical",
      message: none,
      stage: "investigating",
      statuses: [
        { componentId: "web", status: "partial_outage" },
        { componentId: "api", status: "major_outage" },
      ],
      title: { ar: "", en: "Payment gateway" },
    });
  });

  test("it posts each locale's text when each fits, an empty one left out", () => {
    expect(
      newIncidentInputOf(
        {
          impact: "minor",
          message: { ar: " نحقق. ", en: " " },
          stage: "identified",
          statuses: [{ componentId: "web", status: "degraded_performance" }],
          title: { ar: " بطء ", en: "Slow" },
        },
        "ar"
      )
    ).toEqual({
      input: {
        impact: "minor",
        message: { ar: "نحقق." },
        stage: "identified",
        statuses: [{ componentId: "web", status: "degraded_performance" }],
        title: { ar: "بطء", en: "Slow" },
      },
      ok: true,
    });
  });

  test("an empty title, an empty text and no affected component are each refused by name", () => {
    expect(newIncidentInputOf(newIncidentDraftOf(blank, "ar"), "ar")).toEqual({
      errors: {
        components: "incident_refused_components",
        message: "incident_missing_message",
        title: "incident_missing_title",
      },
      ok: false,
    });
  });

  test("a title or a text without the install language's is refused by name, whatever the other locale holds", () => {
    expect(
      newIncidentInputOf(
        {
          impact: "minor",
          message: { ar: "", en: "Looking into it." },
          stage: "investigating",
          statuses: [{ componentId: "web", status: "degraded_performance" }],
          title: { ar: "", en: "Slow" },
        },
        "ar"
      )
    ).toEqual({
      errors: {
        message: "incident_missing_message",
        title: "incident_missing_title",
      },
      ok: false,
    });
  });

  test("a title past 200 characters and a text past 5000 in any locale are refused", () => {
    const parsed = newIncidentInputOf(
      {
        ...newIncidentDraftOf(blank, "ar"),
        message: { ar: "نص", en: "n".repeat(5001) },
        statuses: [{ componentId: "web", status: "major_outage" }],
        title: { ar: "ب".repeat(201), en: "" },
      },
      "ar"
    );
    expect(parsed).toEqual({
      errors: {
        message: "incident_refused_message",
        title: "incident_refused_title",
      },
      ok: false,
    });
  });
});

describe("an update's draft", () => {
  test("it starts at the incident's stage with its latest statuses, keeping nothing and saying nothing in any locale", () => {
    expect(updateDraftOf(stored)).toEqual({
      keep: false,
      message: none,
      stage: "identified",
      statuses: [
        { componentId: "web", status: "partial_outage" },
        { componentId: "api", status: "degraded_performance" },
      ],
    });
  });

  test("at an open stage it posts the statuses, not the keep choice", () => {
    expect(
      updateInputOf(
        {
          ...updateDraftOf(stored),
          keep: true,
          message: { ar: "نتابع.", en: "Watching." },
          stage: "monitoring",
        },
        "ar"
      )
    ).toEqual({
      input: {
        message: { ar: "نتابع.", en: "Watching." },
        stage: "monitoring",
        statuses: [
          { componentId: "web", status: "partial_outage" },
          { componentId: "api", status: "degraded_performance" },
        ],
      },
      ok: true,
    });
  });

  test("resolving posts the keep choice, not the statuses", () => {
    expect(
      updateInputOf(
        {
          ...updateDraftOf(stored),
          keep: true,
          message: arabic("حُلّت."),
          stage: "resolved",
        },
        "ar"
      )
    ).toEqual({
      input: { keep: true, message: { ar: "حُلّت." }, stage: "resolved" },
      ok: true,
    });
  });

  test("an update with no text, or none in the install language, is refused by name", () => {
    expect(updateInputOf(updateDraftOf(stored), "ar")).toEqual({
      errors: { message: "incident_missing_message" },
      ok: false,
    });
    expect(
      updateInputOf(
        { ...updateDraftOf(stored), message: { ar: "نتابع.", en: "" } },
        "en"
      )
    ).toEqual({
      errors: { message: "incident_missing_message" },
      ok: false,
    });
  });

  test("an open update with no affected component is refused by name", () => {
    expect(
      updateInputOf(
        {
          keep: false,
          message: arabic("نتابع."),
          stage: "monitoring",
          statuses: [],
        },
        "ar"
      )
    ).toEqual({
      errors: { components: "incident_refused_components" },
      ok: false,
    });
  });
});

describe("the title and impact edit", () => {
  test("its draft carries the stored title in each locale", () => {
    expect(fieldsDraftOf(stored)).toEqual({
      impact: "major",
      title: { ar: "بطء في الدفع", en: "Slow checkout" },
    });
  });

  test("it posts a title that fits and refuses an empty one or one without the install language's", () => {
    expect(
      fieldsInputOf({ impact: "critical", title: arabic(" توقف ") }, "ar")
    ).toEqual({
      input: { impact: "critical", title: { ar: "توقف" } },
      ok: true,
    });
    expect(fieldsInputOf({ impact: "critical", title: none }, "ar")).toEqual({
      errors: { title: "incident_missing_title" },
      ok: false,
    });
    expect(
      fieldsInputOf({ impact: "critical", title: arabic("توقف") }, "en")
    ).toEqual({
      errors: { title: "incident_missing_title" },
      ok: false,
    });
  });
});

describe("the fix of an update's text", () => {
  test("it posts each locale's text, an empty one left out", () => {
    expect(fixInputOf({ ar: " نص مصحح ", en: "" }, "ar")).toEqual({
      input: { ar: "نص مصحح" },
      ok: true,
    });
  });

  test("a text without the install language's, or past 5000 characters, is refused by name", () => {
    expect(fixInputOf({ ar: "", en: "Fixed text" }, "ar")).toEqual({
      errors: { message: "incident_missing_message" },
      ok: false,
    });
    expect(fixInputOf({ ar: "ن".repeat(5001), en: "" }, "ar")).toEqual({
      errors: { message: "incident_refused_message" },
      ok: false,
    });
  });
});

describe("choosing the affected components", () => {
  const statuses = [
    { componentId: "web", status: "major_outage" as const },
    { componentId: "api", status: "degraded_performance" as const },
  ];

  test("setting a named component's status keeps its place; a new one goes at the end", () => {
    expect(withStatus(statuses, "web", "operational")).toEqual([
      { componentId: "web", status: "operational" },
      { componentId: "api", status: "degraded_performance" },
    ]);
    expect(withStatus(statuses, "db", "partial_outage")).toEqual([
      ...statuses,
      { componentId: "db", status: "partial_outage" },
    ]);
  });

  test("a component added in the draft may be taken out; one the incident affects stays", () => {
    expect(withoutComponent(statuses, "api", ["web"])).toEqual([
      { componentId: "web", status: "major_outage" },
    ]);
    expect(withoutComponent(statuses, "web", ["web"])).toEqual(statuses);
  });
});
