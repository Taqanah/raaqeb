/**
 * The maintenance form's draft: the title,
 * the description, the start and the end as `datetime-local` text in the
 * operator's time zone, and the affected components. It turns into what
 * the form posts for the window's stage through the shared schema and the
 * shared time rules, with one catalog message per refused field: every
 * field while scheduled (a new window is scheduled), the text and the end
 * while in progress, the text once completed. Pure: the form holds one
 * draft in state and calls these, with `now` read when the operator saves.
 * The window's page also learns here when to read the window again, so it
 * follows the stage the scheduler moves it to.
 */
import type { z } from "zod";
import {
  runningEnd,
  type TimesRefusal,
  windowTimes,
} from "@/shared/domain/maintenance.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { fromWallTime, wallTime } from "@/shared/i18n/timezone.ts";
import {
  type ContentDraft,
  contentDraftOf,
  draftWrittenIn,
} from "@/shared/schemas/content.ts";
import {
  type MaintenanceEditInput,
  type MaintenanceInput,
  type MaintenanceStage,
  type MaintenanceWindow,
  maintenanceInputSchema,
  runningEditSchema,
  textEditSchema,
} from "@/shared/schemas/maintenance.ts";

/** The scheduler's tick: a window moves at the first tick past its edge. */
const tickMs = 1000;
/** A timer's longest wait is about 24.8 days; a day keeps every read inside it. */
const dayMs = 86_400_000;

export interface WindowDraft {
  /** The affected components, in the order they were chosen. */
  readonly componentIds: readonly string[];
  /** `datetime-local` text in the operator's time zone. */
  readonly ends: string;
  readonly message: ContentDraft;
  /** `datetime-local` text in the operator's time zone. */
  readonly starts: string;
  readonly title: ContentDraft;
}

/** The refusal of each field that did not fit. */
export type WindowFieldErrors = Readonly<
  Partial<
    Record<"components" | "ends" | "message" | "starts" | "title", MessageId>
  >
>;

export type DraftParse<Input> =
  | { readonly ok: true; readonly input: Input }
  | { readonly ok: false; readonly errors: WindowFieldErrors };

/** Content with no text in any locale. */
const emptyText = contentDraftOf(undefined);

const hourMs = 3_600_000;
const minuteMs = 60_000;

/** A new window's draft: from the next whole hour after the server's read, for an hour, with no component chosen. */
export function newWindowDraftOf(now: number, timeZone: string): WindowDraft {
  // The hour the operator's clock shows now, read back by its minutes, so a repeated hour's second pass is not read as its first; the fields hold minutes, so its seconds never show.
  const minutes = Number(wallTime(now, timeZone).slice(14, 16));
  let start = now - minutes * minuteMs + hourMs;
  // A field reads a repeated hour as its first pass; once that has passed, the next hour is the first it reads forward.
  while ((fromWallTime(wallTime(start, timeZone), timeZone) ?? start) < now) {
    start += hourMs;
  }
  return {
    componentIds: [],
    ends: wallTime(start + hourMs, timeZone),
    message: emptyText,
    starts: wallTime(start, timeZone),
    title: emptyText,
  };
}

/** A stored window's draft, its times as the operator's zone reads them. */
export function windowDraftOf(
  window: MaintenanceWindow,
  timeZone: string
): WindowDraft {
  return {
    componentIds: [...window.componentIds],
    ends: wallTime(window.endsAt, timeZone),
    message: contentDraftOf(window.message),
    starts: wallTime(window.startsAt, timeZone),
    title: contentDraftOf(window.title),
  };
}

const timesRefusals: Readonly<
  Record<
    TimesRefusal,
    { readonly field: "ends" | "starts"; readonly id: MessageId }
  >
> = {
  end_order: { field: "ends", id: "maintenance_refused_end_order" },
  end_past: { field: "ends", id: "maintenance_refused_end_past" },
  start_past: { field: "starts", id: "maintenance_refused_start_past" },
};

/** One refusal per field a parse's issues name. */
function refusalsOf(issues: readonly z.core.$ZodIssue[]): WindowFieldErrors {
  const errors: Partial<Record<keyof WindowFieldErrors, MessageId>> = {};
  for (const issue of issues) {
    const [field] = issue.path;
    if (field === "title") {
      errors.title = "maintenance_refused_title";
    } else if (field === "message") {
      errors.message = "maintenance_refused_message";
    } else if (field === "componentIds") {
      errors.components = "maintenance_refused_components";
    }
  }
  return errors;
}

/** The parse's input, or every refusal: the schema's, the text's without the install language's and the times'. */
function judged<Input>(
  parsed: z.ZodSafeParseResult<Input>,
  draft: WindowDraft,
  language: Locale,
  times: WindowFieldErrors
): DraftParse<Input> {
  const errors = {
    ...(parsed.success ? {} : refusalsOf(parsed.error.issues)),
    ...(draftWrittenIn(draft.title, language, true)
      ? {}
      : { title: "maintenance_missing_title" as const }),
    ...(draftWrittenIn(draft.message, language, true)
      ? {}
      : { message: "maintenance_missing_message" as const }),
    ...times,
  };
  if (parsed.success && Object.keys(errors).length === 0) {
    return { input: parsed.data, ok: true };
  }
  return { errors, ok: false };
}

/** What the new-window form posts, or the refusal of every field that does not fit; the times are read in the zone and judged against now. */
export function newWindowInputOf(
  draft: WindowDraft,
  timeZone: string,
  now: number,
  language: Locale
): DraftParse<MaintenanceInput> {
  const startsAt = fromWallTime(draft.starts, timeZone);
  const endsAt = fromWallTime(draft.ends, timeZone);
  const times: Partial<Record<"ends" | "starts", MessageId>> = {};
  if (startsAt === undefined) {
    times.starts = "maintenance_refused_time";
  }
  if (endsAt === undefined) {
    times.ends = "maintenance_refused_time";
  }
  if (startsAt !== undefined && endsAt !== undefined) {
    const judgement = windowTimes(startsAt, endsAt, now);
    if (!judgement.ok) {
      const { field, id } = timesRefusals[judgement.refusal];
      times[field] = id;
    }
  }
  return judged(
    maintenanceInputSchema.safeParse({
      componentIds: draft.componentIds,
      endsAt: endsAt ?? 0,
      message: draft.message,
      startsAt: startsAt ?? 0,
      title: draft.title,
    }),
    draft,
    language,
    times
  );
}

/** What a stored window's form posts for the stage it read, or the refusal of every field that does not fit. */
export function editInputOf(
  draft: WindowDraft,
  stage: MaintenanceStage,
  timeZone: string,
  now: number,
  language: Locale
): DraftParse<MaintenanceEditInput> {
  if (stage === "scheduled") {
    return newWindowInputOf(draft, timeZone, now, language);
  }
  const text = { message: draft.message, title: draft.title };
  if (stage === "completed") {
    return judged(textEditSchema.safeParse(text), draft, language, {});
  }
  const endsAt = fromWallTime(draft.ends, timeZone);
  const end = endsAt === undefined ? undefined : runningEnd(endsAt, now);
  let times: WindowFieldErrors = {};
  if (end === undefined) {
    times = { ends: "maintenance_refused_time" };
  } else if (!end.ok) {
    times = { ends: "maintenance_refused_end_past" };
  }
  return judged(
    runningEditSchema.safeParse({ ...text, endsAt: endsAt ?? 0 }),
    draft,
    language,
    times
  );
}

/** How long after `now` the window's page reads it again to show its stage moved: a scheduler tick past its start while scheduled, past its end while in progress, at most a day; nothing once completed. */
export function stageReadIn(
  window: Pick<MaintenanceWindow, "endsAt" | "stage" | "startsAt">,
  now: number
): number | undefined {
  if (window.stage === "completed") {
    return;
  }
  const edge = window.stage === "scheduled" ? window.startsAt : window.endsAt;
  return Math.min(Math.max(edge - now, 0) + tickMs, dayMs);
}
