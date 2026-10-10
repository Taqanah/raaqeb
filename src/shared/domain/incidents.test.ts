import { describe, expect, test } from "bun:test";
import type { Incident, IncidentUpdate } from "@/shared/schemas/incident.ts";
import {
  affectedComponents,
  incidentStage,
  latestStatuses,
} from "./incidents.ts";

const t0 = 1_700_000_000_000;

function update(
  id: string,
  overrides: Partial<IncidentUpdate> = {}
): IncidentUpdate {
  return {
    author: "owner@example.com",
    createdAt: t0,
    id,
    message: { ar: "نحقق في المشكلة." },
    stage: "investigating",
    statuses: [],
    ...overrides,
  };
}

function incident(updates: readonly IncidentUpdate[]): Incident {
  return {
    createdAt: t0,
    id: "i",
    impact: "major",
    resolvedAt: undefined,
    title: { ar: "بطء في الدفع" },
    updatedAt: t0,
    updates,
  };
}

describe("what an incident's updates say about it", () => {
  test("its stage is the one its latest update moved it to", () => {
    expect(
      incidentStage(
        incident([
          update("u1"),
          update("u2", { stage: "identified" }),
          update("u3", { stage: "monitoring" }),
        ])
      )
    ).toBe("monitoring");
  });

  test("a stage may move back, and the latest update's stands", () => {
    expect(
      incidentStage(
        incident([
          update("u1", { stage: "monitoring" }),
          update("u2", { stage: "investigating" }),
        ])
      )
    ).toBe("investigating");
  });

  test("the statuses in force are its latest update's, not an earlier one's", () => {
    const statuses = latestStatuses(
      incident([
        update("u1", {
          statuses: [{ componentId: "web", status: "major_outage" }],
        }),
        update("u2", {
          statuses: [
            { componentId: "web", status: "degraded_performance" },
            { componentId: "api", status: "partial_outage" },
          ],
        }),
      ])
    );
    expect(statuses).toEqual([
      { componentId: "web", status: "degraded_performance" },
      { componentId: "api", status: "partial_outage" },
    ]);
  });

  test("the affected components are every one an update named, in the order first named", () => {
    expect(
      affectedComponents(
        incident([
          update("u1", {
            statuses: [{ componentId: "web", status: "major_outage" }],
          }),
          update("u2", {
            statuses: [
              { componentId: "api", status: "partial_outage" },
              { componentId: "web", status: "operational" },
            ],
          }),
        ])
      )
    ).toEqual(["web", "api"]);
  });

  test("a component a later update no longer names is still affected", () => {
    expect(
      affectedComponents(
        incident([
          update("u1", {
            statuses: [{ componentId: "web", status: "major_outage" }],
          }),
          update("u2", { statuses: [] }),
        ])
      )
    ).toEqual(["web"]);
  });
});
