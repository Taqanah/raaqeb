import { describe, expect, test } from "bun:test";
import type { MaintenanceWindow } from "@/shared/schemas/maintenance.ts";
import {
  editInputOf,
  newWindowDraftOf,
  newWindowInputOf,
  stageReadIn,
  type WindowDraft,
  windowDraftOf,
} from "./window-draft.ts";

const riyadh = "Asia/Riyadh";
/** 10:17:30 UTC, 13:17:30 in Riyadh. */
const now = Date.UTC(2026, 8, 26, 10, 17, 30);
const utc = (hours: number, minutes = 0) =>
  Date.UTC(2026, 8, 26, hours, minutes);

const draft: WindowDraft = {
  componentIds: ["web"],
  ends: "2026-09-26T17:00",
  message: { ar: "ننقل قاعدة البيانات إلى خادم أحدث.", en: "" },
  starts: "2026-09-26T15:30",
  title: { ar: "ترقية قاعدة البيانات", en: "Database upgrade" },
};

describe("the maintenance form's drafts", () => {
  test("a new window starts at the next whole hour on the operator's clock, for an hour, with nothing chosen", () => {
    expect(newWindowDraftOf(now, riyadh)).toEqual({
      componentIds: [],
      ends: "2026-09-26T15:00",
      message: { ar: "", en: "" },
      starts: "2026-09-26T14:00",
      title: { ar: "", en: "" },
    });
  });

  test("a stored window reads its times on the operator's clock", () => {
    const window: MaintenanceWindow = {
      componentIds: ["web", "api"],
      createdAt: now,
      endsAt: utc(14),
      id: "w1",
      message: { ar: "نص" },
      stage: "scheduled",
      startsAt: utc(12, 30),
      title: { ar: "صيانة" },
      updatedAt: now,
    };
    expect(windowDraftOf(window, riyadh)).toEqual({
      componentIds: ["web", "api"],
      ends: "2026-09-26T17:00",
      message: { ar: "نص", en: "" },
      starts: "2026-09-26T15:30",
      title: { ar: "صيانة", en: "" },
    });
  });
});

describe("what the new-window form posts", () => {
  test("the times typed on the operator's clock, with the text and the components", () => {
    expect(newWindowInputOf(draft, riyadh, now, "ar")).toEqual({
      input: {
        componentIds: ["web"],
        endsAt: utc(14),
        message: { ar: "ننقل قاعدة البيانات إلى خادم أحدث." },
        startsAt: utc(12, 30),
        title: { ar: "ترقية قاعدة البيانات", en: "Database upgrade" },
      },
      ok: true,
    });
  });

  test("each field that does not fit is refused on its own", () => {
    expect(
      newWindowInputOf(
        {
          componentIds: [],
          ends: "",
          message: { ar: " ", en: "" },
          starts: "",
          title: { ar: "", en: "" },
        },
        riyadh,
        now,
        "ar"
      )
    ).toEqual({
      errors: {
        components: "maintenance_refused_components",
        ends: "maintenance_refused_time",
        message: "maintenance_missing_message",
        starts: "maintenance_refused_time",
        title: "maintenance_missing_title",
      },
      ok: false,
    });
  });

  test("a start in the past and an end not after the start are refused on their fields", () => {
    expect(
      newWindowInputOf(
        { ...draft, starts: "2026-09-26T12:00" },
        riyadh,
        now,
        "ar"
      )
    ).toEqual({
      errors: { starts: "maintenance_refused_start_past" },
      ok: false,
    });
    expect(
      newWindowInputOf(
        { ...draft, ends: "2026-09-26T15:30" },
        riyadh,
        now,
        "ar"
      )
    ).toEqual({
      errors: { ends: "maintenance_refused_end_order" },
      ok: false,
    });
  });

  test("a start in the current minute is not refused", () => {
    const parsed = newWindowInputOf(
      { ...draft, starts: "2026-09-26T13:17" },
      riyadh,
      now,
      "ar"
    );
    expect(parsed.ok).toBe(true);
  });

  test("a title or a description without the install language's text is refused on its field, whatever the other locale holds", () => {
    expect(newWindowInputOf(draft, riyadh, now, "en")).toEqual({
      errors: { message: "maintenance_missing_message" },
      ok: false,
    });
    expect(
      editInputOf(
        { ...draft, title: { ar: "", en: "Database upgrade" } },
        "completed",
        riyadh,
        now,
        "ar"
      )
    ).toEqual({
      errors: { title: "maintenance_missing_title" },
      ok: false,
    });
  });

  test("a text past its limit in the other locale is refused too", () => {
    expect(
      newWindowInputOf(
        { ...draft, message: { ar: "نص", en: "n".repeat(5001) } },
        riyadh,
        now,
        "ar"
      )
    ).toEqual({
      errors: { message: "maintenance_refused_message" },
      ok: false,
    });
  });
});

describe("what a stored window's form posts by its stage", () => {
  test("a scheduled window posts every field, judged as a new one's", () => {
    expect(editInputOf(draft, "scheduled", riyadh, now, "ar")).toEqual(
      newWindowInputOf(draft, riyadh, now, "ar")
    );
    expect(
      editInputOf(
        { ...draft, starts: "2026-09-26T12:00" },
        "scheduled",
        riyadh,
        now,
        "ar"
      )
    ).toEqual({
      errors: { starts: "maintenance_refused_start_past" },
      ok: false,
    });
  });

  test("a window in progress posts its text and its end, whatever its start and components say", () => {
    expect(
      editInputOf(
        { ...draft, componentIds: [], starts: "2026-09-26T09:00" },
        "in_progress",
        riyadh,
        now,
        "ar"
      )
    ).toEqual({
      input: {
        endsAt: utc(14),
        message: { ar: "ننقل قاعدة البيانات إلى خادم أحدث." },
        title: { ar: "ترقية قاعدة البيانات", en: "Database upgrade" },
      },
      ok: true,
    });
    expect(
      editInputOf(
        { ...draft, ends: "2026-09-26T12:00" },
        "in_progress",
        riyadh,
        now,
        "ar"
      )
    ).toEqual({
      errors: { ends: "maintenance_refused_end_past" },
      ok: false,
    });
  });

  test("a completed window posts its text alone", () => {
    expect(
      editInputOf(
        { ...draft, ends: "", starts: "" },
        "completed",
        riyadh,
        now,
        "ar"
      )
    ).toEqual({
      input: {
        message: { ar: "ننقل قاعدة البيانات إلى خادم أحدث." },
        title: { ar: "ترقية قاعدة البيانات", en: "Database upgrade" },
      },
      ok: true,
    });
  });
});

describe("edges of the maintenance form's drafts", () => {
  test("in a zone half an hour off UTC, a new window still starts at the next whole hour on its clock", () => {
    // 10:17:30 UTC is 15:47:30 in Kolkata.
    expect(newWindowDraftOf(now, "Asia/Kolkata")).toMatchObject({
      ends: "2026-09-26T17:00",
      starts: "2026-09-26T16:00",
    });
  });

  test("a window in progress with an end that is not a time refuses the end", () => {
    expect(
      editInputOf({ ...draft, ends: "" }, "in_progress", riyadh, now, "ar")
    ).toEqual({ errors: { ends: "maintenance_refused_time" }, ok: false });
  });
});

describe("a new window's start in the second pass of a repeated hour", () => {
  test("during the second pass of a repeated hour, a new window still starts at the next whole hour, which is not past", () => {
    // 06:30 UTC on 1 November 2026 is 01:30 in New York, the second time that hour runs.
    const repeated = Date.UTC(2026, 10, 1, 6, 30);
    const fresh = newWindowDraftOf(repeated, "America/New_York");
    expect(fresh.starts).toBe("2026-11-01T02:00");
    expect(
      newWindowInputOf(
        {
          ...fresh,
          componentIds: ["web"],
          message: { ar: "نص", en: "" },
          title: { ar: "صيانة", en: "" },
        },
        "America/New_York",
        repeated,
        "ar"
      ).ok
    ).toBe(true);
  });
});

describe("a new window's start in the first pass of a repeated hour", () => {
  test("during the first pass of a repeated hour, a new window starts at a time its field reads forward, which is not past", () => {
    // 05:30 UTC on 1 November 2026 is 01:30 in New York, the first time that hour runs.
    const first = Date.UTC(2026, 10, 1, 5, 30);
    const fresh = newWindowDraftOf(first, "America/New_York");
    expect(fresh.starts).toBe("2026-11-01T02:00");
    expect(
      newWindowInputOf(
        {
          ...fresh,
          componentIds: ["web"],
          message: { ar: "نص", en: "" },
          title: { ar: "صيانة", en: "" },
        },
        "America/New_York",
        first,
        "ar"
      ).ok
    ).toBe(true);
  });
});

describe("when a window's page reads its stage again", () => {
  const tick = 1000;
  const window = {
    endsAt: utc(12),
    stage: "scheduled" as const,
    startsAt: utc(11),
  };

  test("a scheduled window's page reads again a tick after its start", () => {
    expect(stageReadIn(window, now)).toBe(utc(11) - now + tick);
  });

  test("a window in progress's page reads again a tick after its end", () => {
    expect(stageReadIn({ ...window, stage: "in_progress" }, now)).toBe(
      utc(12) - now + tick
    );
  });

  test("a window whose edge has passed, as after End now, reads again at the next tick", () => {
    expect(
      stageReadIn({ ...window, endsAt: now, stage: "in_progress" }, now)
    ).toBe(tick);
    expect(
      stageReadIn({ ...window, stage: "in_progress" }, utc(12) + 5 * tick)
    ).toBe(tick);
  });

  test("a window months away reads again within a day, which a timer can hold", () => {
    expect(
      stageReadIn({ ...window, startsAt: now + 90 * 86_400_000 }, now)
    ).toBe(86_400_000);
  });

  test("a completed window's page has nothing left to follow", () => {
    expect(stageReadIn({ ...window, stage: "completed" }, now)).toBeUndefined();
  });
});
