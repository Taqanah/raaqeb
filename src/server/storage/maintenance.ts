/**
 * The maintenance windows repository (CONTEXT.md "Maintenance window"): one row per window and the components it affects as rows beside
 * it. A window is written with its components in one transaction. Its
 * stage moves only through `advance`, a guarded write, so each move happens
 * once however many ticks or restarts race it; every
 * other write is guarded on the stage the caller read. Windows are never
 * purged. Rows never leave this file: every answer is a
 * `MaintenanceWindow` of shared/schemas.
 */
import { inArray, type SQL, sql } from "drizzle-orm";
import type { Content } from "@/shared/schemas/content.ts";
import {
  type MaintenanceStage,
  type MaintenanceWindow,
  maintenanceStageSchema,
} from "@/shared/schemas/maintenance.ts";
import type { Executor } from "./connection.ts";
import { contentText, storedContent } from "./content.ts";

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
  /** Replaces what the edit names while the window is still at `stage`; nothing when the id is unknown or the window moved on. Throws `NoWindowComponentError` and changes nothing when it names components of which none exists. */
  edit: (
    id: string,
    stage: MaintenanceStage,
    edit: WindowEdit
  ) => Promise<MaintenanceWindow | undefined>;
  /** The window with that id, or nothing. */
  find: (id: string) => Promise<MaintenanceWindow | undefined>;
  /** Every window, in creation order. */
  list: () => Promise<MaintenanceWindow[]>;
  /** Deletes a window that has not started; answers whether it did. */
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

/** Thrown by a read when a stored stage is not one this version knows, or its title or text is not content; the message names the window. */
export class MaintenanceShapeError extends Error {
  readonly windowId: string;
  constructor(id: string) {
    super(`the stored maintenance window ${id} does not fit its schema`);
    this.name = "MaintenanceShapeError";
    this.windowId = id;
  }
}

/** A window row as the driver answers it. */
interface WindowRow {
  created_at: number;
  ends_at: number;
  id: string;
  message: string;
  stage: string;
  starts_at: number;
  title: string;
  updated_at: number;
}

/** Ids are UUIDv7 text generated here; `newId` is a parameter so a test can fix them. */
export function maintenanceRepository(
  executor: Executor,
  now: () => number,
  newId: () => string = () => Bun.randomUUIDv7()
): MaintenanceRepository {
  const { components, maintenanceComponents, maintenanceWindows } =
    executor.tables;
  const column = (name: string) => sql.identifier(name);

  // ponytail: `list` carries every window with its components; a page of the list once installs hold thousands.
  const read = async (
    run: Executor,
    where: SQL
  ): Promise<MaintenanceWindow[]> => {
    const rows = await run.rows<WindowRow>(
      sql`SELECT ${maintenanceWindows.id} AS id, ${maintenanceWindows.title} AS title, ${maintenanceWindows.message} AS message, ${maintenanceWindows.startsAt} AS starts_at, ${maintenanceWindows.endsAt} AS ends_at, ${maintenanceWindows.stage} AS stage, ${maintenanceWindows.createdAt} AS created_at, ${maintenanceWindows.updatedAt} AS updated_at FROM ${maintenanceWindows} ${where} ORDER BY ${maintenanceWindows.createdAt}, ${maintenanceWindows.id}`
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

  /** Writes the window's components and answers how many landed; a component id that does not exist is skipped by the select. */
  const link = async (
    run: Executor,
    windowId: string,
    componentIds: readonly string[]
  ): Promise<number> => {
    let written = 0;
    for (const componentId of componentIds) {
      // biome-ignore lint/performance/noAwaitInLoops: a transaction's statements run one after another on its one connection
      written += await run.run(
        sql`INSERT INTO ${maintenanceComponents} (${column("window_id")}, ${column("component_id")}) SELECT ${windowId}, ${components.id} FROM ${components} WHERE ${components.id} = ${componentId}`
      );
    }
    return written;
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
        const id = newId();
        const time = now();
        await tx.run(
          sql`INSERT INTO ${maintenanceWindows} (${column("id")}, ${column("title")}, ${column("message")}, ${column("starts_at")}, ${column("ends_at")}, ${column("stage")}, ${column("created_at")}, ${column("updated_at")}) VALUES (${id}, ${contentText(fields.title)}, ${contentText(fields.message)}, ${fields.startsAt}, ${fields.endsAt}, ${"scheduled"}, ${time}, ${time})`
        );
        // Checked in the write itself, so a component deleted a moment before cannot leave a window on no page.
        if ((await link(tx, id, fields.componentIds)) === 0) {
          throw new NoWindowComponentError();
        }
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
          if ((await link(tx, id, edit.componentIds)) === 0) {
            throw new NoWindowComponentError();
          }
        }
        return findOne(tx, id);
      }),
    find: (id) => findOne(executor, id),
    list: () => read(executor, sql``),
    remove: async (id) =>
      (await executor.run(
        sql`DELETE FROM ${maintenanceWindows} WHERE ${maintenanceWindows.id} = ${id} AND ${maintenanceWindows.stage} = ${"scheduled"}`
      )) > 0,
    since: (from) =>
      read(
        executor,
        sql`WHERE ${maintenanceWindows.stage} <> ${"scheduled"} AND ${maintenanceWindows.endsAt} > ${from}`
      ),
    unfinished: () =>
      read(executor, sql`WHERE ${maintenanceWindows.stage} <> ${"completed"}`),
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
    stage: stage.data,
    startsAt: row.starts_at,
    title,
    updatedAt: row.updated_at,
  };
}
