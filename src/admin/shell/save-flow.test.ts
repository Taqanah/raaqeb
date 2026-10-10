import { describe, expect, test } from "bun:test";
import {
  flowOf,
  lineOf,
  nextFlow,
  type SaveEvent,
  type SaveFlow,
  sameDraft,
  viewOf,
} from "./save-flow.ts";

interface Draft {
  readonly name: string;
  readonly tags: readonly string[];
}

type Refusal = "invalid" | "unavailable";

const stored: Draft = { name: "API", tags: ["prod"] };
const renamed: Draft = { name: "Public API", tags: ["prod"] };

function after(
  ...events: SaveEvent<Draft, Refusal>[]
): SaveFlow<Draft, Refusal> {
  return events.reduce(nextFlow, flowOf<Draft, Refusal>(stored));
}

describe("comparing drafts", () => {
  test("two drafts with the same values are the same, whatever order their fields were set in", () => {
    expect(
      sameDraft({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })
    ).toBe(true);
  });

  test("a different value, a list in another order, or a field more or less makes them differ", () => {
    expect(sameDraft({ a: "1" }, { a: 1 })).toBe(false);
    expect(sameDraft({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameDraft({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameDraft({ a: [1] }, { a: [1, 1] })).toBe(false);
    expect(sameDraft({ a: null }, { a: {} })).toBe(false);
  });

  test("a list and a record with the same entries differ, as do two fields left empty under different names", () => {
    expect(sameDraft([1], { 0: 1 })).toBe(false);
    expect(sameDraft({ a: undefined }, { b: undefined })).toBe(false);
  });
});

describe("a form's Save", () => {
  test("cannot be pressed while the form holds what it started from, a field changed back to its saved value included", () => {
    const view = viewOf(after(), { name: "API", tags: ["prod"] });
    expect(view.changed).toBe(false);
    expect(view.canSave).toBe(false);
    expect(view.line).toEqual({ kind: "none" });
  });

  test("can be pressed once a field changes, and the line says the changes are unsaved", () => {
    const view = viewOf(after(), renamed);
    expect(view.changed).toBe(true);
    expect(view.canSave).toBe(true);
    expect(view.line).toEqual({ kind: "unsaved" });
  });

  test("cannot be pressed while the save runs, and the line waits for its outcome", () => {
    const view = viewOf(after({ draft: renamed, kind: "pending" }), renamed);
    expect(view.pending).toBe(true);
    expect(view.canSave).toBe(false);
    expect(view.line).toEqual({ kind: "none" });
  });

  test("a change typed while the save runs leaves Save resting and the line waiting", () => {
    const view = viewOf(after({ draft: renamed, kind: "pending" }), {
      ...renamed,
      name: "Public API v2",
    });
    expect(view.canSave).toBe(false);
    expect(view.line).toEqual({ kind: "none" });
  });

  test("a new record copied from another starts worth saving, since its start differs from the form's empty draft", () => {
    const flow = flowOf<Draft, Refusal>({ name: "", tags: [] });
    expect(viewOf(flow, renamed).canSave).toBe(true);
  });
});

describe("after a save", () => {
  test("the saved draft is the new baseline: Save rests and the line says saved", () => {
    const flow = after(
      { draft: renamed, kind: "pending" },
      { draft: renamed, kind: "saved" }
    );
    const view = viewOf(flow, renamed);
    expect(view.canSave).toBe(false);
    expect(view.pending).toBe(false);
    expect(view.line).toEqual({ kind: "saved" });
  });

  test("the next change, or one typed while the save ran, clears the saved line and enables Save again", () => {
    const flow = after(
      { draft: renamed, kind: "pending" },
      { draft: renamed, kind: "saved" }
    );
    const view = viewOf(flow, { ...renamed, name: "Public API v2" });
    expect(view.canSave).toBe(true);
    expect(view.line).toEqual({ kind: "unsaved" });
  });

  test("the draft the form holds after the save is the baseline, when it differs from the one sent (a posted text cleared)", () => {
    const cleared: Draft = { name: "", tags: ["prod"] };
    const flow = after(
      { draft: renamed, kind: "pending" },
      { draft: cleared, kind: "saved" }
    );
    expect(viewOf(flow, cleared)).toEqual({
      canSave: false,
      changed: false,
      line: { kind: "saved" },
      pending: false,
    });
  });
});

describe("a refused save", () => {
  test("names its reason on the line and leaves Save pressable, the changes still unsaved", () => {
    const flow = after(
      { draft: renamed, kind: "pending" },
      { draft: renamed, kind: "failed", reason: "unavailable" }
    );
    const view = viewOf(flow, renamed);
    expect(view.line).toEqual({ kind: "failed", reason: "unavailable" });
    expect(view.canSave).toBe(true);
    expect(view.changed).toBe(true);
  });

  test("shows on the line when the form refused it before sending, with no save running", () => {
    const flow = after({ draft: renamed, kind: "failed", reason: "invalid" });
    expect(viewOf(flow, renamed).line).toEqual({
      kind: "failed",
      reason: "invalid",
    });
  });

  test("gives its line up to the next change", () => {
    const flow = after({ draft: renamed, kind: "failed", reason: "invalid" });
    expect(viewOf(flow, { ...renamed, name: "Fixed" }).line).toEqual({
      kind: "unsaved",
    });
  });

  test("keeps its line when the record moved under the form and the form took the new values in, keeping the text typed", () => {
    const moved: Draft = { name: "API", tags: ["prod", "eu"] };
    const kept: Draft = { name: "Public API", tags: ["prod", "eu"] };
    const flow = after(
      { draft: renamed, kind: "pending" },
      { draft: renamed, kind: "failed", reason: "unavailable" },
      { baseline: moved, draft: kept, kind: "rebased" }
    );
    const view = viewOf(flow, kept);
    expect(view.line).toEqual({ kind: "failed", reason: "unavailable" });
    expect(view.canSave).toBe(true);
  });
});

describe("a record moved under the form", () => {
  test("is the new baseline: the form compares with what is stored now", () => {
    const moved: Draft = { name: "API", tags: ["prod", "eu"] };
    const flow = after({ baseline: moved, draft: moved, kind: "rebased" });
    expect(viewOf(flow, moved).canSave).toBe(false);
    expect(viewOf(flow, stored).canSave).toBe(true);
  });
});

describe("a command's outcome on the line", () => {
  test("shows saved and refusals, and nothing while idle or running", () => {
    expect(lineOf<Refusal>({ kind: "idle" })).toEqual({ kind: "none" });
    expect(lineOf<Refusal>({ kind: "pending" })).toEqual({ kind: "none" });
    expect(lineOf<Refusal>({ kind: "saved" })).toEqual({ kind: "saved" });
    expect(lineOf<Refusal>({ kind: "failed", reason: "invalid" })).toEqual({
      kind: "failed",
      reason: "invalid",
    });
  });
});
