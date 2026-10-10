/**
 * The incidents repository (CONTEXT.md "Incident", "Incident update"): one row per incident, its updates as rows beside it, and the status
 * each update set on each affected component as rows beside those, with
 * the status the component showed before the update that first named it. An
 * incident is written with its first update, and every update with its
 * statuses, in one transaction; a resolving update also resolves the
 * incident, and the hand-set statuses the module hands over (on resolving)
 * are written in the same write. Incidents are never purged. Rows never leave
 * this file: every answer is an `Incident` of shared/schemas.
 */
import { inArray, type SQL, sql } from "drizzle-orm";
import type { Content } from "@/shared/schemas/content.ts";
import {
  type Incident,
  type IncidentFields,
  type IncidentStage,
  type IncidentStatus,
  impactLevelSchema,
  incidentStageSchema,
} from "@/shared/schemas/incident.ts";
import {
  handSetLevelSchema,
  type StatusLevel,
  statusLevelSchema,
} from "@/shared/schemas/status.ts";
import type { Executor } from "./connection.ts";
import { contentText, storedContent } from "./content.ts";

/** An update as it is written; its id and time are the repository's. */
export interface UpdateFields {
  readonly author: string;
  /** The status the page showed for each component this update names for the first time, kept beside its status; a status's own `before` is never written. */
  readonly before?: ReadonlyMap<string, StatusLevel>;
  readonly message: Content;
  readonly stage: IncidentStage;
  /** A component id that does not exist is skipped. */
  readonly statuses: readonly IncidentStatus[];
}

export interface IncidentsRepository {
  /** Every incident still open or resolved after `from`, in creation order. */
  activeSince: (from: number) => Promise<Incident[]>;
  /** Stores a new incident with its first update and answers it with its id; throws `NoAffectedComponentError` and stores nothing when none of its components exists. */
  create: (fields: IncidentFields, first: UpdateFields) => Promise<Incident>;
  /** Replaces the title and the impact level; nothing when the id is unknown. */
  edit: (id: string, fields: IncidentFields) => Promise<Incident | undefined>;
  /** The incident with that id, or nothing. */
  find: (id: string) => Promise<Incident | undefined>;
  /** Replaces one update's text; nothing when the incident or the update is unknown. */
  fix: (
    id: string,
    updateId: string,
    message: Content
  ) => Promise<Incident | undefined>;
  /** Every incident, in creation order. */
  list: () => Promise<Incident[]>;
  /** Every incident still open, in creation order. */
  open: () => Promise<Incident[]>;
  /**
   * Adds an update to an open incident whose latest update is still `after`,
   * the one the caller read, and writes each of `handSet` as that
   * component's hand-set status in the same write; a resolving update
   * resolves it. The update is stamped at least a millisecond after the one
   * it follows, so a clock that stepped back never reorders them. Nothing
   * when the id is unknown, the incident is resolved, or another update
   * landed since `after`.
   */
  post: (
    id: string,
    update: UpdateFields,
    handSet: readonly IncidentStatus[],
    after: string
  ) => Promise<Incident | undefined>;
  /** Deletes the incident with its updates; answers whether it existed. */
  remove: (id: string) => Promise<boolean>;
}

/** Thrown by `create` when none of the new incident's components exists by the time it is written, which would leave it on no page; nothing is stored. */
export class NoAffectedComponentError extends Error {
  constructor() {
    super("none of the incident's components exists");
    this.name = "NoAffectedComponentError";
  }
}

/** Thrown by a read when a stored impact level, stage or status is not one this version knows, or a title or an update's text is not content; the message names the incident. */
export class IncidentShapeError extends Error {
  readonly incidentId: string;
  constructor(id: string) {
    super(`the stored incident ${id} does not fit its schema`);
    this.name = "IncidentShapeError";
    this.incidentId = id;
  }
}

/** An incident row as the driver answers it. */
interface IncidentRow {
  created_at: number;
  id: string;
  impact: string;
  resolved_at: number | null;
  title: string;
  updated_at: number;
}

/** An update row as the driver answers it. */
interface UpdateRow {
  author: string;
  created_at: number;
  id: string;
  incident_id: string;
  message: string;
  stage: string;
}

/** A status row as the driver answers it. */
interface StatusRow {
  component_id: string;
  status: string;
  status_before: string | null;
  update_id: string;
}

/** Ids are UUIDv7 text generated here; `newId` is a parameter so a test can fix them. */
export function incidentsRepository(
  executor: Executor,
  now: () => number,
  newId: () => string = () => Bun.randomUUIDv7()
): IncidentsRepository {
  const { components, incidentStatuses, incidentUpdates, incidents } =
    executor.tables;
  const column = (name: string) => sql.identifier(name);

  // ponytail: every read carries each incident's whole history; a page of the list once installs hold thousands.
  const read = async (run: Executor, where: SQL): Promise<Incident[]> => {
    const rows = await run.rows<IncidentRow>(
      sql`SELECT ${incidents.id} AS id, ${incidents.title} AS title, ${incidents.impact} AS impact, ${incidents.createdAt} AS created_at, ${incidents.updatedAt} AS updated_at, ${incidents.resolvedAt} AS resolved_at FROM ${incidents} ${where} ORDER BY ${incidents.createdAt}, ${incidents.id}`
    );
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.id);
    // One after the other: `run` may be a transaction's one connection.
    const updates = await run.rows<UpdateRow>(
      sql`SELECT ${incidentUpdates.id} AS id, ${incidentUpdates.incidentId} AS incident_id, ${incidentUpdates.stage} AS stage, ${incidentUpdates.message} AS message, ${incidentUpdates.author} AS author, ${incidentUpdates.createdAt} AS created_at FROM ${incidentUpdates} WHERE ${inArray(incidentUpdates.incidentId, ids)} ORDER BY ${incidentUpdates.createdAt}, ${incidentUpdates.id}`
    );
    const statuses = await run.rows<StatusRow>(
      sql`SELECT ${incidentStatuses.updateId} AS update_id, ${incidentStatuses.componentId} AS component_id, ${incidentStatuses.status} AS status, ${incidentStatuses.statusBefore} AS status_before FROM ${incidentStatuses} JOIN ${incidentUpdates} ON ${incidentUpdates.id} = ${incidentStatuses.updateId} JOIN ${components} ON ${components.id} = ${incidentStatuses.componentId} WHERE ${inArray(incidentUpdates.incidentId, ids)} ORDER BY ${components.createdAt}, ${components.id}`
    );
    const byUpdate = grouped(statuses, (row) => row.update_id);
    const byIncident = grouped(updates, (row) => row.incident_id);
    return rows.map((row) =>
      incidentOf(row, byIncident.get(row.id) ?? [], byUpdate)
    );
  };
  const findOne = async (run: Executor, id: string) =>
    (await read(run, sql`WHERE ${incidents.id} = ${id}`))[0];

  /** Writes one update with its statuses and answers how many statuses landed; a component id that does not exist is skipped by the select. */
  const write = async (
    run: Executor,
    incidentId: string,
    update: UpdateFields,
    time: number
  ): Promise<number> => {
    const id = newId();
    let written = 0;
    await run.run(
      sql`INSERT INTO ${incidentUpdates} (${column("id")}, ${column("incident_id")}, ${column("stage")}, ${column("message")}, ${column("author")}, ${column("created_at")}) VALUES (${id}, ${incidentId}, ${update.stage}, ${contentText(update.message)}, ${update.author}, ${time})`
    );
    for (const { componentId, status } of update.statuses) {
      // biome-ignore lint/performance/noAwaitInLoops: a transaction's statements run one after another on its one connection
      written += await run.run(
        sql`INSERT INTO ${incidentStatuses} (${column("update_id")}, ${column("component_id")}, ${column("status")}, ${column("status_before")}) SELECT ${id}, ${components.id}, ${status}, ${update.before?.get(componentId) ?? null} FROM ${components} WHERE ${components.id} = ${componentId}`
      );
    }
    return written;
  };

  return {
    activeSince: (from) =>
      read(
        executor,
        sql`WHERE ${incidents.resolvedAt} IS NULL OR ${incidents.resolvedAt} > ${from}`
      ),
    create: (fields, first) =>
      executor.transaction(async (tx) => {
        const id = newId();
        const time = now();
        await tx.run(
          sql`INSERT INTO ${incidents} (${column("id")}, ${column("title")}, ${column("impact")}, ${column("created_at")}, ${column("updated_at")}) VALUES (${id}, ${contentText(fields.title)}, ${fields.impact}, ${time}, ${time})`
        );
        // Checked in the write itself, so a component deleted a moment before cannot leave an incident on no page.
        if ((await write(tx, id, first, time)) === 0) {
          throw new NoAffectedComponentError();
        }
        const created = await findOne(tx, id);
        if (!created) {
          throw new Error(`the incident ${id} was not stored`);
        }
        return created;
      }),
    edit: async (id, fields) => {
      const changed = await executor.run(
        sql`UPDATE ${incidents} SET ${column("title")} = ${contentText(fields.title)}, ${column("impact")} = ${fields.impact}, ${column("updated_at")} = ${now()} WHERE ${incidents.id} = ${id}`
      );
      return changed === 0 ? undefined : findOne(executor, id);
    },
    find: (id) => findOne(executor, id),
    fix: (id, updateId, message) =>
      executor.transaction(async (tx) => {
        const changed = await tx.run(
          sql`UPDATE ${incidentUpdates} SET ${column("message")} = ${contentText(message)} WHERE ${incidentUpdates.id} = ${updateId} AND ${incidentUpdates.incidentId} = ${id}`
        );
        if (changed === 0) {
          return;
        }
        await tx.run(
          sql`UPDATE ${incidents} SET ${column("updated_at")} = ${now()} WHERE ${incidents.id} = ${id}`
        );
        return findOne(tx, id);
      }),
    list: () => read(executor, sql``),
    open: () => read(executor, sql`WHERE ${incidents.resolvedAt} IS NULL`),
    post: (id, update, handSet, after) =>
      executor.transaction(async (tx) => {
        // Locks the incident's row, so an update posted at the same moment waits here and then reads this one.
        const open = await tx.run(
          sql`UPDATE ${incidents} SET ${column("updated_at")} = ${incidents.updatedAt} WHERE ${incidents.id} = ${id} AND ${incidents.resolvedAt} IS NULL`
        );
        if (open === 0) {
          return;
        }
        const [latest] = await tx.rows<{ created_at: number; id: string }>(
          sql`SELECT ${incidentUpdates.id} AS id, ${incidentUpdates.createdAt} AS created_at FROM ${incidentUpdates} WHERE ${incidentUpdates.incidentId} = ${id} ORDER BY ${incidentUpdates.createdAt} DESC, ${incidentUpdates.id} DESC LIMIT 1`
        );
        if (latest?.id !== after) {
          return;
        }
        // Never before the update it follows, so a clock that stepped back cannot reorder them.
        const time = Math.max(now(), latest.created_at + 1);
        const resolvedAt = update.stage === "resolved" ? time : null;
        await tx.run(
          sql`UPDATE ${incidents} SET ${column("updated_at")} = ${time}, ${column("resolved_at")} = ${resolvedAt} WHERE ${incidents.id} = ${id}`
        );
        await write(tx, id, update, time);
        for (const { componentId, status } of handSet) {
          // biome-ignore lint/performance/noAwaitInLoops: a transaction's statements run one after another on its one connection
          await tx.run(
            sql`UPDATE ${components} SET ${column("status")} = ${status}, ${column("updated_at")} = ${time} WHERE ${components.id} = ${componentId}`
          );
        }
        return findOne(tx, id);
      }),
    remove: async (id) =>
      (await executor.run(
        sql`DELETE FROM ${incidents} WHERE ${incidents.id} = ${id}`
      )) > 0,
  };
}

/** The rows by key, each list in the rows' order (`Map.groupBy` is outside the TypeScript lib the repo targets). */
function grouped<Row>(
  rows: readonly Row[],
  key: (row: Row) => string
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  }
  return groups;
}

function incidentOf(
  row: IncidentRow,
  updates: readonly UpdateRow[],
  statuses: ReadonlyMap<string, readonly StatusRow[]>
): Incident {
  const impact = impactLevelSchema.safeParse(row.impact);
  const title = storedContent(row.title);
  if (!(impact.success && title)) {
    throw new IncidentShapeError(row.id);
  }
  return {
    createdAt: row.created_at,
    id: row.id,
    impact: impact.data,
    resolvedAt: row.resolved_at ?? undefined,
    title,
    updatedAt: row.updated_at,
    updates: updates.map((update) => {
      const stage = incidentStageSchema.safeParse(update.stage);
      const message = storedContent(update.message);
      if (!(stage.success && message)) {
        throw new IncidentShapeError(row.id);
      }
      return {
        author: update.author,
        createdAt: update.created_at,
        id: update.id,
        message,
        stage: stage.data,
        statuses: (statuses.get(update.id) ?? []).map((each) => {
          const status = handSetLevelSchema.safeParse(each.status);
          const before = statusLevelSchema
            .nullable()
            .safeParse(each.status_before);
          if (!(status.success && before.success)) {
            throw new IncidentShapeError(row.id);
          }
          return {
            ...(before.data === null ? {} : { before: before.data }),
            componentId: each.component_id,
            status: status.data,
          };
        }),
      };
    }),
  };
}
