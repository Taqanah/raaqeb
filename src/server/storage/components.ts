/**
 * The components repository (CONTEXT.md "Component", "Link"):
 * one row per component with its hand-set status, and its links to
 * monitors as rows beside it, written in the same transaction. Deleting a
 * component takes it off every page, and with it every incident and
 * maintenance window that names no other component; deleting a monitor
 * drops its links.
 * Rows never leave this file: every answer is a `Component` of
 * shared/schemas.
 */
import { inArray, type SQL, sql } from "drizzle-orm";
import type { Component, ComponentFields } from "@/shared/schemas/component.ts";
import { handSetLevelSchema } from "@/shared/schemas/status.ts";
import type { Executor } from "./connection.ts";
import { contentText, storedContent } from "./content.ts";

export interface ComponentsRepository {
  /** Stores a new component and its links; a monitor id that does not exist is skipped. Answers it with its id. */
  create: (fields: ComponentFields) => Promise<Component>;
  /** The component with that id, or nothing. */
  find: (id: string) => Promise<Component | undefined>;
  /** Every component with its links, in creation order. */
  list: () => Promise<Component[]>;
  /** Deletes the component, and in the same write every incident and maintenance window that names no other component; answers whether it existed. */
  remove: (id: string) => Promise<boolean>;
  /** Replaces the name, the description, the hand-set status and the links; nothing when the id is unknown. */
  update: (
    id: string,
    fields: ComponentFields
  ) => Promise<Component | undefined>;
}

/** Thrown by a read when a stored hand-set status is not one this version knows, or its name or description is not content; the message names the component. */
export class ComponentShapeError extends Error {
  readonly componentId: string;
  constructor(id: string) {
    super(`the stored component ${id} does not fit its schema`);
    this.name = "ComponentShapeError";
    this.componentId = id;
  }
}

/** A component row as the driver answers it. */
interface ComponentRow {
  created_at: number;
  description: string | null;
  id: string;
  name: string;
  status: string;
  updated_at: number;
}

/** Ids are UUIDv7 text generated here; `newId` is a parameter so a test can fix them. */
export function componentsRepository(
  executor: Executor,
  now: () => number,
  newId: () => string = () => Bun.randomUUIDv7()
): ComponentsRepository {
  const {
    componentMonitors,
    components,
    incidentStatuses,
    incidentUpdates,
    incidents,
    maintenanceComponents,
    maintenanceWindows,
    monitors,
  } = executor.tables;
  const column = (name: string) => sql.identifier(name);

  const read = async (run: Executor, where: SQL): Promise<Component[]> => {
    const rows = await run.rows<ComponentRow>(
      sql`SELECT ${components.id} AS id, ${components.name} AS name, ${components.description} AS description, ${components.status} AS status, ${components.createdAt} AS created_at, ${components.updatedAt} AS updated_at FROM ${components} ${where} ORDER BY ${components.createdAt}, ${components.id}`
    );
    if (rows.length === 0) {
      return [];
    }
    const links = await run.rows<{ component_id: string; monitor_id: string }>(
      sql`SELECT ${componentMonitors.componentId} AS component_id, ${componentMonitors.monitorId} AS monitor_id FROM ${componentMonitors} JOIN ${monitors} ON ${monitors.id} = ${componentMonitors.monitorId} WHERE ${inArray(
        componentMonitors.componentId,
        rows.map((row) => row.id)
      )} ORDER BY ${monitors.createdAt}, ${monitors.id}`
    );
    const linked = new Map<string, string[]>();
    for (const row of links) {
      linked.set(row.component_id, [
        ...(linked.get(row.component_id) ?? []),
        row.monitor_id,
      ]);
    }
    return rows.map((row) => componentOf(row, linked.get(row.id) ?? []));
  };
  const findOne = async (run: Executor, id: string) =>
    (await read(run, sql`WHERE ${components.id} = ${id}`))[0];

  /** Replaces the component's links; an id no monitor has is skipped by the select. */
  const link = async (
    run: Executor,
    id: string,
    monitorIds: readonly string[]
  ) => {
    await run.run(
      sql`DELETE FROM ${componentMonitors} WHERE ${componentMonitors.componentId} = ${id}`
    );
    if (monitorIds.length > 0) {
      await run.run(
        sql`INSERT INTO ${componentMonitors} (${column("component_id")}, ${column("monitor_id")}) SELECT ${id}, ${monitors.id} FROM ${monitors} WHERE ${inArray(monitors.id, [...monitorIds])}`
      );
    }
  };

  return {
    create: (fields) =>
      executor.transaction(async (tx) => {
        const id = newId();
        const time = now();
        await tx.run(
          sql`INSERT INTO ${components} (${column("id")}, ${column("name")}, ${column("description")}, ${column("status")}, ${column("created_at")}, ${column("updated_at")}) VALUES (${id}, ${contentText(fields.name)}, ${fields.description ? contentText(fields.description) : null}, ${fields.status}, ${time}, ${time})`
        );
        await link(tx, id, fields.monitorIds);
        const created = await findOne(tx, id);
        if (!created) {
          throw new Error(`the component ${id} was not stored`);
        }
        return created;
      }),
    find: (id) => findOne(executor, id),
    list: () => read(executor, sql``),
    remove: (id) =>
      executor.transaction(async (tx) => {
        // An incident or a window that names no other component would be on no page, so it goes with this one; one left so before goes too.
        await tx.run(
          sql`DELETE FROM ${incidents} WHERE NOT EXISTS (SELECT 1 FROM ${incidentStatuses} JOIN ${incidentUpdates} ON ${incidentUpdates.id} = ${incidentStatuses.updateId} WHERE ${incidentUpdates.incidentId} = ${incidents.id} AND ${incidentStatuses.componentId} <> ${id})`
        );
        await tx.run(
          sql`DELETE FROM ${maintenanceWindows} WHERE NOT EXISTS (SELECT 1 FROM ${maintenanceComponents} WHERE ${maintenanceComponents.windowId} = ${maintenanceWindows.id} AND ${maintenanceComponents.componentId} <> ${id})`
        );
        return (
          (await tx.run(
            sql`DELETE FROM ${components} WHERE ${components.id} = ${id}`
          )) > 0
        );
      }),
    update: (id, fields) =>
      executor.transaction(async (tx) => {
        const changed = await tx.run(
          sql`UPDATE ${components} SET ${column("name")} = ${contentText(fields.name)}, ${column("description")} = ${fields.description ? contentText(fields.description) : null}, ${column("status")} = ${fields.status}, ${column("updated_at")} = ${now()} WHERE ${components.id} = ${id}`
        );
        if (changed === 0) {
          return;
        }
        await link(tx, id, fields.monitorIds);
        return findOne(tx, id);
      }),
  };
}

function componentOf(row: ComponentRow, monitorIds: string[]): Component {
  const status = handSetLevelSchema.safeParse(row.status);
  const name = storedContent(row.name);
  const description =
    row.description === null ? undefined : storedContent(row.description);
  if (!(status.success && name) || (row.description !== null && !description)) {
    throw new ComponentShapeError(row.id);
  }
  return {
    createdAt: row.created_at,
    description,
    id: row.id,
    monitorIds,
    name,
    status: status.data,
    updatedAt: row.updated_at,
  };
}
