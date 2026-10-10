/**
 * The incident server functions: the list, the new-incident
 * page's read, an incident's page, create, the title and impact edit, an
 * update (the resolving one too), an update's text fix and delete. Each
 * sits behind the operator session check, and a write is signed with the
 * operator's email as its author. Not a route file (the leading dash); the
 * incident routes share them. A function parses with the Zod schema and
 * calls one module.
 */

import { createServerFn } from "@tanstack/react-start";
import {
  createIncident,
  deleteIncident,
  editIncident,
  fixUpdate,
  listIncidents,
  postUpdate,
  readIncident,
  readNewIncident,
} from "@/server/incidents/incidents.ts";
import { announceThrough } from "@/server/notify/subscribers.ts";
import {
  type IncidentDeleteResult,
  type IncidentListResult,
  type IncidentPageResult,
  type IncidentSaveResult,
  incidentCreateSchema,
  incidentEditSchema,
  incidentIdSchema,
  incidentPostSchema,
  type NewIncidentResult,
  newIncidentSearchSchema,
  updateFixSchema,
} from "@/shared/schemas/incident.ts";
import { operatorMiddleware } from "./-admin.ts";

export const readIncidentListFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<IncidentListResult> =>
      listIncidents(context.storage, Date.now())
  );

export const readNewIncidentFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(newIncidentSearchSchema)
  .handler(
    ({ context, data }): Promise<NewIncidentResult> =>
      readNewIncident(context.storage, data.monitor)
  );

export const readIncidentFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(incidentIdSchema)
  .handler(
    ({ context, data }): Promise<IncidentPageResult> =>
      readIncident(context.storage, data.id, Date.now())
  );

export const createIncidentFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(incidentCreateSchema)
  .handler(
    ({ context, data }): Promise<IncidentSaveResult> =>
      createIncident(
        context.storage,
        data,
        context.operator.email,
        announceThrough(context.scheduler?.subscribers)
      )
  );

export const editIncidentFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(incidentEditSchema)
  .handler(
    ({ context, data }): Promise<IncidentSaveResult> =>
      editIncident(context.storage, data.id, data.input)
  );

export const postUpdateFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(incidentPostSchema)
  .handler(
    ({ context, data }): Promise<IncidentSaveResult> =>
      postUpdate(
        context.storage,
        data.id,
        data.input,
        context.operator.email,
        announceThrough(context.scheduler?.subscribers)
      )
  );

export const fixUpdateFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(updateFixSchema)
  .handler(
    ({ context, data }): Promise<IncidentSaveResult> =>
      fixUpdate(context.storage, data.id, data.updateId, data.message)
  );

export const deleteIncidentFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(incidentIdSchema)
  .handler(
    ({ context, data }): Promise<IncidentDeleteResult> =>
      deleteIncident(context.storage, data.id)
  );
