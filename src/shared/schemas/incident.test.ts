import { describe, expect, test } from "bun:test";
import {
  incidentCreateSchema,
  incidentUpdateSchema,
  newIncidentSearchSchema,
} from "./incident.ts";

const opening = {
  impact: "major",
  message: { ar: "نحقق." },
  stage: "investigating",
  statuses: [{ componentId: "web", status: "major_outage" }],
  title: { ar: "بطء" },
};

describe("what the incident forms post", () => {
  test("a component named twice keeps its first status", () => {
    expect(
      incidentCreateSchema.parse({
        ...opening,
        statuses: [
          { componentId: "web", status: "major_outage" },
          { componentId: "api", status: "partial_outage" },
          { componentId: "web", status: "operational" },
        ],
      }).statuses
    ).toEqual([
      { componentId: "web", status: "major_outage" },
      { componentId: "api", status: "partial_outage" },
    ]);
  });

  test("an incident cannot be opened resolved, nor set a component under maintenance", () => {
    expect(
      incidentCreateSchema.safeParse({ ...opening, stage: "resolved" }).success
    ).toBe(false);
    expect(
      incidentCreateSchema.safeParse({
        ...opening,
        statuses: [{ componentId: "web", status: "under_maintenance" }],
      }).success
    ).toBe(false);
  });

  test("an impact level outside the four is refused", () => {
    expect(
      incidentCreateSchema.safeParse({ ...opening, impact: "severe" }).success
    ).toBe(false);
  });

  test("a resolving update carries the keep choice and never statuses; an open one carries statuses", () => {
    expect(
      incidentUpdateSchema.parse({
        keep: true,
        message: { ar: "حُلّت." },
        stage: "resolved",
        statuses: [{ componentId: "web", status: "major_outage" }],
      })
    ).toEqual({ keep: true, message: { ar: "حُلّت." }, stage: "resolved" });
    expect(
      incidentUpdateSchema.safeParse({
        message: { ar: "حُلّت." },
        stage: "resolved",
      }).success
    ).toBe(false);
    expect(
      incidentUpdateSchema.safeParse({
        message: { ar: "نتابع." },
        stage: "monitoring",
        statuses: [],
      }).success
    ).toBe(false);
  });

  test("the new-incident page's search reads a monitor id and ignores anything else", () => {
    expect(newIncidentSearchSchema.parse({ monitor: "m1" })).toEqual({
      monitor: "m1",
    });
    expect(newIncidentSearchSchema.parse({ monitor: 7 })).toEqual({
      monitor: undefined,
    });
    expect(newIncidentSearchSchema.parse({})).toEqual({});
  });
});
