/**
 * The maintenance server functions: the list, the new-window
 * page's read, a window's page, schedule, edit, end now and cancel. Each
 * sits behind the operator session check. Not a route file (the leading
 * dash); the maintenance routes share them. A function parses with the Zod
 * schema and calls one module.
 */

import { createServerFn } from "@tanstack/react-start";
import {
  createWindow,
  deleteWindow,
  editWindow,
  endWindow,
  listWindows,
  readNewWindow,
  readWindow,
} from "@/server/maintenance/maintenance.ts";
import { announceThrough } from "@/server/notify/subscribers.ts";
import {
  type MaintenanceDeleteResult,
  type MaintenanceListResult,
  type MaintenancePageResult,
  type MaintenanceSaveResult,
  maintenanceEditSchema,
  maintenanceIdSchema,
  maintenanceInputSchema,
  type NewMaintenanceResult,
} from "@/shared/schemas/maintenance.ts";
import { operatorMiddleware } from "./-admin.ts";

export const readMaintenanceListFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<MaintenanceListResult> =>
      listWindows(context.storage, Date.now())
  );

export const readNewMaintenanceFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<NewMaintenanceResult> =>
      readNewWindow(context.storage, Date.now())
  );

export const readMaintenanceFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(maintenanceIdSchema)
  .handler(
    ({ context, data }): Promise<MaintenancePageResult> =>
      readWindow(context.storage, data.id, Date.now())
  );

export const createMaintenanceFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(maintenanceInputSchema)
  .handler(
    ({ context, data }): Promise<MaintenanceSaveResult> =>
      createWindow(
        context.storage,
        data,
        Date.now(),
        announceThrough(context.scheduler?.subscribers)
      )
  );

export const editMaintenanceFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(maintenanceEditSchema)
  .handler(
    ({ context, data }): Promise<MaintenanceSaveResult> =>
      editWindow(
        context.storage,
        data.id,
        data.input,
        Date.now(),
        announceThrough(context.scheduler?.subscribers)
      )
  );

export const endMaintenanceFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(maintenanceIdSchema)
  .handler(
    ({ context, data }): Promise<MaintenanceSaveResult> =>
      endWindow(context.storage, data.id, Date.now())
  );

export const deleteMaintenanceFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(maintenanceIdSchema)
  .handler(
    ({ context, data }): Promise<MaintenanceDeleteResult> =>
      deleteWindow(
        context.storage,
        data.id,
        Date.now(),
        announceThrough(context.scheduler?.subscribers)
      )
  );
