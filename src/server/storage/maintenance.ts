/**
 * The maintenance windows repository (CONTEXT.md "Maintenance window"): one row per window and the components it affects as rows beside
 * it. A window is written with its components in one transaction. Its
 * stage moves only through `advance`, a guarded write, so each move happens
 * once however many ticks or restarts race it; every
 * other write is guarded on the stage the caller read. Windows are never
 * purged. A maintenance series (CONTEXT.md "Maintenance series") is one row
 * with its components beside it; each occurrence it schedules is a window
 * row naming it, written in the same transaction as the series moves on.
 * Rows never leave this file: every answer is a `MaintenanceWindow` or a
 * `MaintenanceSeries` of shared/schemas.
 */
import { inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { OccurrenceTimes } from "@/shared/domain/series.ts";
import type { Content } from "@/shared/schemas/content.ts";
import {
  type MaintenanceSeries,
  type MaintenanceStage,
  type MaintenanceWindow,
  maintenanceStageSchema,
  type Recurrence,
  recurrenceSchema,
} from "@/shared/schemas/maintenance.ts";
import type { Executor } from "./connection.ts";
import { contentText, parseJson, storedContent } from "./content.ts";

/** A window as it is written; its id, stage and times of record are the repository's. */
export interface WindowFields {
  /** A component id that does not exist is skipped. */
  readonly componentIds: readonly string[];
  readonly endsAt: number;
  readonly message: Content;
  readonly startsAt: number;
  readonly title: Content;
}

/** What an edit replaces: the text always, and whichever of the rest it names. */
export interface WindowEdit {
  readonly componentIds?: readonly string[];
  readonly endsAt?: number;
  readonly message: Content;
  readonly startsAt?: number;
  readonly title: Content;
}

/** A series as it is written; its id and times of record are the repository's. */
export interface SeriesFields {
  /** A component id that does not exist is skipped. */
  readonly componentIds: readonly string[];
  readonly message: Content;
  readonly recurrence: Recurrence;
  readonly title: Content;
}

/** What a series write did to its occurrences, each window in its new state; a cancelled one as it was before its delete. */
export interface SeriesWrite {
  readonly cancelled: MaintenanceWindow[];
  /** Kept at its start with another end. */
  readonly rescheduled: MaintenanceWindow[];
  readonly scheduled: MaintenanceWindow[];
  readonly series: MaintenanceSeries;
}

export interface MaintenanceRepository {
  /**
   * Moves every window whose time has come: a scheduled one whose start has
   * passed goes in progress, one whose end has passed completes, straight
   * from scheduled when both passed. Answers the windows it moved in their
   * new stage, in creation order.
   */
  advance: (now: number) => Promise<MaintenanceWindow[]>;
  /** Stores a new scheduled window with its components; throws `NoWindowComponentError` and stores nothing when none of them exists. */
  create: (fields: WindowFields) => Promise<MaintenanceWindow>;
  /** Stores a new series with its components and schedules an occurrence at each of `occurrences`, every one before `until` counted as scheduled. Throws `NoWindowComponentError` and stores nothing when none of the components exists. */
  createSeries: (
    fields: SeriesFields,
    occurrences: readonly OccurrenceTimes[],
    until: number
  ) => Promise<SeriesWrite>;
  /** Replaces what the edit names while the window is still at `stage`; nothing when the id is unknown or the window moved on. Throws `NoWindowComponentError` and changes nothing when it names components of which none exists. */
  edit: (
    id: string,
    stage: MaintenanceStage,
    edit: WindowEdit
  ) => Promise<MaintenanceWindow | undefined>;
  /**
   * Replaces a series' fields and its scheduled occurrences yet to start
   * (their start and the start the series gave them both after `from`) with
   * the times given: one the series gave a start given keeps its row with
   * the series' text, components and times; every other scheduled one is cancelled; a
   * time none starts at is scheduled, unless an occurrence at it was
   * cancelled on its own. Occurrences in progress or completed
   * stay as they are. Nothing when the id is unknown; throws
   * `NoWindowComponentError` and changes nothing when none of the components
   * exists.
   */
  editSeries: (
    id: string,
    fields: SeriesFields,
    occurrences: readonly OccurrenceTimes[],
    from: number,
    until: number
  ) => Promise<SeriesWrite | undefined>;
  /** Deletes a series and cancels its scheduled occurrences, answering them as they were; its others stay as windows of no series. Nothing when the id is unknown. */
  endSeries: (id: string) => Promise<MaintenanceWindow[] | undefined>;
  /** Schedules a series' occurrences while it is still scheduled until `from`, then counts it scheduled until `until`; answers the windows, or nothing when another write moved it on or it is gone. */
  extendSeries: (
    id: string,
    from: number,
    occurrences: readonly OccurrenceTimes[],
    until: number
  ) => Promise<MaintenanceWindow[] | undefined>;
  /** The window with that id, or nothing. */
  find: (id: string) => Promise<MaintenanceWindow | undefined>;
  /** The series with that id, or nothing. */
  findSeries: (id: string) => Promise<MaintenanceSeries | undefined>;
  /** Every window, in creation order. */
  list: () => Promise<MaintenanceWindow[]>;
  /** Every series, in creation order. */
  listSeries: () => Promise<MaintenanceSeries[]>;
  /** Deletes a window that has not started; answers whether it did. An occurrence's start is kept by its series as skipped, so an edit of the series does not schedule it again. */
  remove: (id: string) => Promise<boolean>;
  /** Every window that has started and ends after `from`, in creation order: the ones whose time leaves observed time. */
  since: (from: number) => Promise<MaintenanceWindow[]>;
  /** Every window not completed, in creation order. */
  unfinished: () => Promise<MaintenanceWindow[]>;
}

/** Thrown by `create` and `edit` when none of the window's components exists by the time it is written, which would leave it on no page; nothing is stored. */
export class NoWindowComponentError extends Error {
  constructor() {
    super("none of the maintenance window's components exists");
    this.name = "NoWindowComponentError";
  }
}

/** Thrown by a read when a stored stage is not one this version knows, its title or text is not content, or a series' recurrence does not fit; the message names the window or the series. */
export class MaintenanceShapeError extends Error {
  readonly windowId: string;
  constructor(id: string) {
    super(
      `the stored maintenance window or series ${id} does not fit its schema`
    );
    this.name = "MaintenanceShapeError";
    this.windowId = id;
  }
}

const skippedSchema = z.array(z.number());

/** A window row as the driver answers it. */
interface WindowRow {
  created_at: number;
  ends_at: number;
  id: string;
  message: string;
  series_id: string | null;
  stage: string;
  starts_at: number;
  title: string;
  updated_at: number;
}

/** A series row as the driver answers it. */
interface SeriesRow {
  created_at: number;
  id: string;
  message: string;
  recurrence: string;
  scheduled_until: number;
  title: string;
  updated_at: number;
}

/** Ids are UUIDv7 text generated here; `newId` is a parameter so a test can fix them. */
export function maintenanceRepository(
  executor: Executor,
  now: () => number,
  newId: () => string = () => Bun.randomUUIDv7()
): MaintenanceRepository {
  const {
    components,
    maintenanceComponents,
    maintenanceSeries,
    maintenanceSeriesComponents,
    maintenanceWindows,
  } = executor.tables;
  const column = (name: string) => sql.identifier(name);

  // ponytail: `list` carries every window with its components; a page of the list once installs hold thousands.
  const read = async (
    run: Executor,
    where: SQL
  ): Promise<MaintenanceWindow[]> => {
    const rows = await run.rows<WindowRow>(
      sql`SELECT ${maintenanceWindows.id} AS id, ${maintenanceWindows.title} AS title, ${maintenanceWindows.message} AS message, ${maintenanceWindows.startsAt} AS starts_at, ${maintenanceWindows.endsAt} AS ends_at, ${maintenanceWindows.stage} AS stage, ${maintenanceWindows.createdAt} AS created_at, ${maintenanceWindows.updatedAt} AS updated_at, ${maintenanceWindows.seriesId} AS series_id FROM ${maintenanceWindows} ${where} ORDER BY ${maintenanceWindows.createdAt}, ${maintenanceWindows.id}`
    );
    if (rows.length === 0) {
      return [];
    }
    // One after the other: `run` may be a transaction's one connection.
    const rowsOfLinks = await run.rows<{
      component_id: string;
      window_id: string;
    }>(
      sql`SELECT ${maintenanceComponents.windowId} AS window_id, ${maintenanceComponents.componentId} AS component_id FROM ${maintenanceComponents} JOIN ${components} ON ${components.id} = ${maintenanceComponents.componentId} WHERE ${inArray(
        maintenanceComponents.windowId,
        rows.map((row) => row.id)
      )} ORDER BY ${components.createdAt}, ${components.id}`
    );
    return rows.map((row) =>
      windowOf(
        row,
        rowsOfLinks
          .filter((each) => each.window_id === row.id)
          .map((each) => each.component_id)
      )
    );
  };
  const findOne = async (run: Executor, id: string) =>
    (await read(run, sql`WHERE ${maintenanceWindows.id} = ${id}`))[0];

  const readSeries = async (
    run: Executor,
    where: SQL
  ): Promise<MaintenanceSeries[]> => {
    const rows = await run.rows<SeriesRow>(
      sql`SELECT ${maintenanceSeries.id} AS id, ${maintenanceSeries.title} AS title, ${maintenanceSeries.message} AS message, ${maintenanceSeries.recurrence} AS recurrence, ${maintenanceSeries.scheduledUntil} AS scheduled_until, ${maintenanceSeries.createdAt} AS created_at, ${maintenanceSeries.updatedAt} AS updated_at FROM ${maintenanceSeries} ${where} ORDER BY ${maintenanceSeries.createdAt}, ${maintenanceSeries.id}`
    );
    if (rows.length === 0) {
      return [];
    }
    const rowsOfLinks = await run.rows<{
      component_id: string;
      series_id: string;
    }>(
      sql`SELECT ${maintenanceSeriesComponents.seriesId} AS series_id, ${maintenanceSeriesComponents.componentId} AS component_id FROM ${maintenanceSeriesComponents} JOIN ${components} ON ${components.id} = ${maintenanceSeriesComponents.componentId} WHERE ${inArray(
        maintenanceSeriesComponents.seriesId,
        rows.map((row) => row.id)
      )} ORDER BY ${components.createdAt}, ${components.id}`
    );
    return rows.map((row) =>
      seriesOf(
        row,
        rowsOfLinks
          .filter((each) => each.series_id === row.id)
          .map((each) => each.component_id)
      )
    );
  };
  const findSeriesOne = async (run: Executor, id: string) =>
    (await readSeries(run, sql`WHERE ${maintenanceSeries.id} = ${id}`))[0];
  const scheduledOf = (run: Executor, seriesId: string) =>
    read(
      run,
      sql`WHERE ${maintenanceWindows.seriesId} = ${seriesId} AND ${maintenanceWindows.stage} = ${"scheduled"}`
    );

  /** A series' scheduled occurrences yet to start, by the start the series gave each: one whose start or series start has come is the tick's. */
  const ahead = async (
    run: Executor,
    seriesId: string,
    from: number
  ): Promise<Map<number, MaintenanceWindow>> => {
    const rows = await run.rows<{ id: string; series_starts_at: number }>(
      sql`SELECT ${maintenanceWindows.id} AS id, ${maintenanceWindows.seriesStartsAt} AS series_starts_at FROM ${maintenanceWindows} WHERE ${maintenanceWindows.seriesId} = ${seriesId} AND ${maintenanceWindows.stage} = ${"scheduled"} AND ${maintenanceWindows.startsAt} > ${from} AND ${maintenanceWindows.seriesStartsAt} >= ${from}`
    );
    if (rows.length === 0) {
      return new Map();
    }
    const windows = new Map(
      (
        await read(
          run,
          sql`WHERE ${inArray(
            maintenanceWindows.id,
            rows.map((row) => row.id)
          )}`
        )
      ).map((window) => [window.id, window])
    );
    return new Map(
      rows.flatMap((row) => {
        const window = windows.get(row.id);
        return window ? [[Number(row.series_starts_at), window] as const] : [];
      })
    );
  };

  /** Writes the components of a window or a series and answers how many landed; a component id that does not exist is skipped by the select. */
  const link = async (
    run: Executor,
    to: { readonly seriesId: string } | { readonly windowId: string },
    componentIds: readonly string[]
  ): Promise<number> => {
    const [table, key, id] =
      "seriesId" in to
        ? [maintenanceSeriesComponents, "series_id", to.seriesId]
        : [maintenanceComponents, "window_id", to.windowId];
    let written = 0;
    for (const componentId of componentIds) {
      // biome-ignore lint/performance/noAwaitInLoops: a transaction's statements run one after another on its one connection
      written += await run.run(
        sql`INSERT INTO ${table} (${column(key)}, ${column("component_id")}) SELECT ${id}, ${components.id} FROM ${components} WHERE ${components.id} = ${componentId}`
      );
    }
    return written;
  };

  /** Stores a scheduled window with its components, of a series or of none; throws `NoWindowComponentError` when none of them exists. */
  const insert = async (
    run: Executor,
    fields: WindowFields,
    seriesId: string | null
  ): Promise<string> => {
    const id = newId();
    const time = now();
    // An occurrence keeps the start its series gave it, whatever the operator moves it to.
    await run.run(
      sql`INSERT INTO ${maintenanceWindows} (${column("id")}, ${column("title")}, ${column("message")}, ${column("starts_at")}, ${column("ends_at")}, ${column("stage")}, ${column("created_at")}, ${column("updated_at")}, ${column("series_id")}, ${column("series_starts_at")}) VALUES (${id}, ${contentText(fields.title)}, ${contentText(fields.message)}, ${fields.startsAt}, ${fields.endsAt}, ${"scheduled"}, ${time}, ${time}, ${seriesId}, ${seriesId === null ? null : fields.startsAt})`
    );
    // Checked in the write itself, so a component deleted a moment before cannot leave a window on no page.
    if ((await link(run, { windowId: id }, fields.componentIds)) === 0) {
      throw new NoWindowComponentError();
    }
    return id;
  };

  /** Schedules the series' occurrences at the times given, in their order, and reads them back. */
  const schedule = async (
    run: Executor,
    series: MaintenanceSeries,
    occurrences: readonly OccurrenceTimes[]
  ): Promise<MaintenanceWindow[]> => {
    const ids: string[] = [];
    for (const times of occurrences) {
      // biome-ignore lint/performance/noAwaitInLoops: a transaction's statements run one after another on its one connection
      ids.push(await insert(run, { ...series, ...times }, series.id));
    }
    return ids.length === 0
      ? []
      : read(run, sql`WHERE ${inArray(maintenanceWindows.id, ids)}`);
  };

  /** The starts of a series' occurrences cancelled on their own; a stored list that does not fit reads as none. */
  const skippedOf = async (run: Executor, seriesId: string) => {
    const [row] = await run.rows<{ skipped: string }>(
      sql`SELECT ${maintenanceSeries.skippedStarts} AS skipped FROM ${maintenanceSeries} WHERE ${maintenanceSeries.id} = ${seriesId}`
    );
    const parsed = skippedSchema.safeParse(parseJson(row?.skipped ?? "[]"));
    return parsed.success ? parsed.data : [];
  };

  /** Gives a scheduled occurrence the series' text, components and times. */
  const keep = async (
    run: Executor,
    kept: MaintenanceWindow,
    series: MaintenanceSeries,
    times: OccurrenceTimes
  ) => {
    await run.run(
      sql`UPDATE ${maintenanceWindows} SET ${column("title")} = ${contentText(series.title)}, ${column("message")} = ${contentText(series.message)}, ${column("starts_at")} = ${times.startsAt}, ${column("ends_at")} = ${times.endsAt}, ${column("updated_at")} = ${now()} WHERE ${maintenanceWindows.id} = ${kept.id}`
    );
    await run.run(
      sql`DELETE FROM ${maintenanceComponents} WHERE ${maintenanceComponents.windowId} = ${kept.id}`
    );
    await link(run, { windowId: kept.id }, series.componentIds);
  };

  /** Replaces a series' occurrences yet to start with the times given: one the series gave a start given is kept, the rest cancelled, the new starts scheduled. */
  const replan = async (
    run: Executor,
    series: MaintenanceSeries,
    occurrences: readonly OccurrenceTimes[],
    from: number
  ): Promise<SeriesWrite> => {
    const byStart = await ahead(run, series.id, from);
    const skipped = new Set(await skippedOf(run, series.id));
    const fresh: OccurrenceTimes[] = [];
    const moved: string[] = [];
    // An occurrence cancelled on its own stays cancelled.
    for (const times of occurrences.filter(
      (each) => !skipped.has(each.startsAt)
    )) {
      const kept = byStart.get(times.startsAt);
      byStart.delete(times.startsAt);
      if (!kept) {
        fresh.push(times);
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: a transaction's statements run one after another on its one connection
      await keep(run, kept, series, times);
      if (kept.startsAt !== times.startsAt || kept.endsAt !== times.endsAt) {
        moved.push(kept.id);
      }
    }
    const cancelled = [...byStart.values()];
    if (cancelled.length > 0) {
      await run.run(
        sql`DELETE FROM ${maintenanceWindows} WHERE ${inArray(
          maintenanceWindows.id,
          cancelled.map((each) => each.id)
        )}`
      );
    }
    return {
      cancelled,
      rescheduled:
        moved.length === 0
          ? []
          : await read(
              run,
              sql`WHERE ${inArray(maintenanceWindows.id, moved)}`
            ),
      scheduled: await schedule(run, series, fresh),
      series,
    };
  };

  /** The series as just written; a write that left no row is a bug, not an answer. */
  const written = async (run: Executor, id: string) => {
    const series = await findSeriesOne(run, id);
    if (!series) {
      throw new Error(`the maintenance series ${id} was not stored`);
    }
    return series;
  };

  return {
    advance: (time) =>
      executor.transaction(async (tx) => {
        // Completed first, so a window whose start and end both passed goes straight there.
        const completed = await tx.rows<{ id: string }>(
          sql`UPDATE ${maintenanceWindows} SET ${column("stage")} = ${"completed"}, ${column("updated_at")} = ${time} WHERE ${maintenanceWindows.stage} <> ${"completed"} AND ${maintenanceWindows.endsAt} <= ${time} RETURNING ${maintenanceWindows.id} AS id`
        );
        const started = await tx.rows<{ id: string }>(
          sql`UPDATE ${maintenanceWindows} SET ${column("stage")} = ${"in_progress"}, ${column("updated_at")} = ${time} WHERE ${maintenanceWindows.stage} = ${"scheduled"} AND ${maintenanceWindows.startsAt} <= ${time} RETURNING ${maintenanceWindows.id} AS id`
        );
        const moved = [...completed, ...started].map((row) => row.id);
        return moved.length === 0
          ? []
          : read(tx, sql`WHERE ${inArray(maintenanceWindows.id, moved)}`);
      }),
    create: (fields) =>
      executor.transaction(async (tx) => {
        const id = await insert(tx, fields, null);
        const created = await findOne(tx, id);
        if (!created) {
          throw new Error(`the maintenance window ${id} was not stored`);
        }
        return created;
      }),
    edit: (id, stage, edit) =>
      executor.transaction(async (tx) => {
        const set = [
          sql`${column("title")} = ${contentText(edit.title)}`,
          sql`${column("message")} = ${contentText(edit.message)}`,
          sql`${column("updated_at")} = ${now()}`,
          ...(edit.startsAt === undefined
            ? []
            : [sql`${column("starts_at")} = ${edit.startsAt}`]),
          ...(edit.endsAt === undefined
            ? []
            : [sql`${column("ends_at")} = ${edit.endsAt}`]),
        ];
        // Guarded on the stage the caller read, so an edit the scheduler overtook changes nothing.
        const changed = await tx.run(
          sql`UPDATE ${maintenanceWindows} SET ${sql.join(set, sql`, `)} WHERE ${maintenanceWindows.id} = ${id} AND ${maintenanceWindows.stage} = ${stage}`
        );
        if (changed === 0) {
          return;
        }
        if (edit.componentIds !== undefined) {
          await tx.run(
            sql`DELETE FROM ${maintenanceComponents} WHERE ${maintenanceComponents.windowId} = ${id}`
          );
          if ((await link(tx, { windowId: id }, edit.componentIds)) === 0) {
            throw new NoWindowComponentError();
          }
        }
        return findOne(tx, id);
      }),
    find: (id) => findOne(executor, id),
    list: () => read(executor, sql``),
    remove: (id) =>
      executor.transaction(async (tx) => {
        const [removed] = await tx.rows<{
          series_id: string | null;
          series_starts_at: number | null;
        }>(
          sql`DELETE FROM ${maintenanceWindows} WHERE ${maintenanceWindows.id} = ${id} AND ${maintenanceWindows.stage} = ${"scheduled"} RETURNING ${maintenanceWindows.seriesId} AS series_id, ${maintenanceWindows.seriesStartsAt} AS series_starts_at`
        );
        if (removed?.series_id && removed.series_starts_at !== null) {
          // A write that names the row first: on Postgres it waits for another cancel's, so it reads the list that one left.
          const [row] = await tx.rows<{ skipped: string }>(
            sql`UPDATE ${maintenanceSeries} SET ${column("skipped_starts")} = ${maintenanceSeries.skippedStarts} WHERE ${maintenanceSeries.id} = ${removed.series_id} RETURNING ${maintenanceSeries.skippedStarts} AS skipped`
          );
          const parsed = skippedSchema.safeParse(
            parseJson(row?.skipped ?? "[]")
          );
          // Starts already past can never be scheduled again, so they are dropped as this one is kept.
          const kept = [
            ...(parsed.success ? parsed.data : []).filter(
              (start) => start >= now()
            ),
            Number(removed.series_starts_at),
          ];
          await tx.run(
            sql`UPDATE ${maintenanceSeries} SET ${column("skipped_starts")} = ${JSON.stringify(kept)} WHERE ${maintenanceSeries.id} = ${removed.series_id}`
          );
        }
        return removed !== undefined;
      }),
    since: (from) =>
      read(
        executor,
        sql`WHERE ${maintenanceWindows.stage} <> ${"scheduled"} AND ${maintenanceWindows.endsAt} > ${from}`
      ),
    unfinished: () =>
      read(executor, sql`WHERE ${maintenanceWindows.stage} <> ${"completed"}`),
    createSeries: (fields, occurrences, until) =>
      executor.transaction(async (tx) => {
        const id = newId();
        const time = now();
        await tx.run(
          sql`INSERT INTO ${maintenanceSeries} (${column("id")}, ${column("title")}, ${column("message")}, ${column("recurrence")}, ${column("scheduled_until")}, ${column("created_at")}, ${column("updated_at")}) VALUES (${id}, ${contentText(fields.title)}, ${contentText(fields.message)}, ${JSON.stringify(fields.recurrence)}, ${until}, ${time}, ${time})`
        );
        if ((await link(tx, { seriesId: id }, fields.componentIds)) === 0) {
          throw new NoWindowComponentError();
        }
        const series = await written(tx, id);
        return {
          cancelled: [],
          rescheduled: [],
          scheduled: await schedule(tx, series, occurrences),
          series,
        };
      }),
    editSeries: (id, fields, occurrences, from, until) =>
      executor.transaction(async (tx) => {
        // The series' row first: on Postgres its lock holds off a pass extending it until this write is done.
        const changed = await tx.run(
          sql`UPDATE ${maintenanceSeries} SET ${column("title")} = ${contentText(fields.title)}, ${column("message")} = ${contentText(fields.message)}, ${column("recurrence")} = ${JSON.stringify(fields.recurrence)}, ${column("scheduled_until")} = ${until}, ${column("updated_at")} = ${now()} WHERE ${maintenanceSeries.id} = ${id}`
        );
        if (changed === 0) {
          return;
        }
        await tx.run(
          sql`DELETE FROM ${maintenanceSeriesComponents} WHERE ${maintenanceSeriesComponents.seriesId} = ${id}`
        );
        if ((await link(tx, { seriesId: id }, fields.componentIds)) === 0) {
          throw new NoWindowComponentError();
        }
        return replan(tx, await written(tx, id), occurrences, from);
      }),
    endSeries: (id) =>
      executor.transaction(async (tx) => {
        if (!(await findSeriesOne(tx, id))) {
          return;
        }
        const cancelled = await scheduledOf(tx, id);
        await tx.run(
          sql`DELETE FROM ${maintenanceWindows} WHERE ${maintenanceWindows.seriesId} = ${id} AND ${maintenanceWindows.stage} = ${"scheduled"}`
        );
        // The started and completed occurrences stay, as windows of no series.
        await tx.run(
          sql`DELETE FROM ${maintenanceSeries} WHERE ${maintenanceSeries.id} = ${id}`
        );
        return cancelled;
      }),
    extendSeries: (id, from, occurrences, until) =>
      executor.transaction(async (tx) => {
        // Guarded on how far the caller read it scheduled, so two passes never schedule one occurrence twice.
        const changed = await tx.run(
          sql`UPDATE ${maintenanceSeries} SET ${column("scheduled_until")} = ${until} WHERE ${maintenanceSeries.id} = ${id} AND ${maintenanceSeries.scheduledUntil} = ${from}`
        );
        if (changed === 0) {
          return;
        }
        return schedule(tx, await written(tx, id), occurrences);
      }),
    findSeries: (id) => findSeriesOne(executor, id),
    listSeries: () => readSeries(executor, sql``),
  };
}

function windowOf(
  row: WindowRow,
  componentIds: readonly string[]
): MaintenanceWindow {
  const stage = maintenanceStageSchema.safeParse(row.stage);
  const title = storedContent(row.title);
  const message = storedContent(row.message);
  if (!(stage.success && title && message)) {
    throw new MaintenanceShapeError(row.id);
  }
  return {
    componentIds,
    createdAt: row.created_at,
    endsAt: row.ends_at,
    id: row.id,
    message,
    ...(row.series_id === null ? {} : { seriesId: row.series_id }),
    stage: stage.data,
    startsAt: row.starts_at,
    title,
    updatedAt: row.updated_at,
  };
}

/** A recurrence's JSON text as the schema reads it, or nothing. */
function storedRecurrence(text: string): Recurrence | undefined {
  const parsed = recurrenceSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : undefined;
}

function seriesOf(
  row: SeriesRow,
  componentIds: readonly string[]
): MaintenanceSeries {
  const recurrence = storedRecurrence(row.recurrence);
  const title = storedContent(row.title);
  const message = storedContent(row.message);
  if (!(recurrence && title && message)) {
    throw new MaintenanceShapeError(row.id);
  }
  return {
    componentIds,
    createdAt: row.created_at,
    id: row.id,
    message,
    recurrence,
    scheduledUntil: row.scheduled_until,
    title,
    updatedAt: row.updated_at,
  };
}
