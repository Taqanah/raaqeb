/**
 * The monitor server functions: create, edit, pause, resume
 * and delete, the selection bar's change of a channel, the group or a tag, the list read, the form read, "test now", a Docker daemon's containers for the form, the detail read,
 * one check's record, "check now", acknowledging an outage and dismissing the
 * getting-started checklist, each behind the
 * operator session check. Not a route file (the leading dash); the list
 * route and the form share them. A function parses with the Zod schema and
 * calls one module.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { requestOriginHeader } from "@/server/boot/proxies.ts";
import {
  containerListTimeoutMs,
  listContainers,
} from "@/server/checks/docker.ts";
import { requestDocker } from "@/server/checks/docker-io.ts";
import { liveIo } from "@/server/checks/io.ts";
import {
  acknowledgeOutage,
  checkNow,
  readCheckRecord,
  readMonitorDetail,
} from "@/server/monitors/detail.ts";
import {
  changeMonitors,
  createMonitor,
  deleteMonitors,
  editMonitor,
  listMonitorChoices,
  listMonitors,
  pauseMonitors,
  readMonitorForm,
  resumeMonitors,
  testMonitor,
} from "@/server/monitors/monitors.ts";
import { dismissGettingStarted } from "@/server/settings/getting-started.ts";
import { readOperatorClock } from "@/server/settings/operator.ts";
import { longestCheckMs } from "@/shared/domain/checks.ts";
import type { TimeOptions } from "@/shared/i18n/format.ts";
import {
  type AcknowledgeResult,
  acknowledgeSchema,
  type CheckNowResult,
  type CheckRecordResult,
  checkNowSchema,
  checkRecordReadSchema,
  type MonitorDetailResult,
  monitorDetailReadSchema,
} from "@/shared/schemas/detail.ts";
import {
  type ContainerListResult,
  containerListSchema,
  type MonitorBulkResult,
  type MonitorChoicesResult,
  type MonitorFormResult,
  type MonitorListResult,
  type MonitorSaveResult,
  type MonitorTestResult,
  monitorChangeInputSchema,
  monitorEditSchema,
  monitorFormReadSchema,
  monitorIdsSchema,
  monitorInputSchema,
  monitorTestSchema,
  timeoutMaxMs,
} from "@/shared/schemas/monitor.ts";
import type { SaveResult } from "@/shared/schemas/settings.ts";
import { operatorMiddleware } from "./-admin.ts";

export const readMonitorList = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<MonitorListResult> =>
      listMonitors(context.storage, Date.now())
  );

/** The command palette's read: names and targets alone, never the list's bars. */
export const readMonitorChoicesFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<MonitorChoicesResult> =>
      listMonitorChoices(context.storage)
  );

export const createMonitorFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(monitorInputSchema)
  .handler(
    ({ context, data }): Promise<MonitorSaveResult> =>
      createMonitor(context.storage, context.boot.installKey, data)
  );

export const editMonitorFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(monitorEditSchema)
  .handler(
    ({ context, data }): Promise<MonitorSaveResult> =>
      editMonitor(
        context.storage,
        context.boot.installKey,
        data.id,
        data.input,
        { renewHeartbeatUrl: data.renewHeartbeatUrl }
      )
  );

export const pauseMonitorsFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(monitorIdsSchema)
  .handler(
    ({ context, data }): Promise<MonitorBulkResult> =>
      pauseMonitors(context.storage, data.ids)
  );

export const resumeMonitorsFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(monitorIdsSchema)
  .handler(
    ({ context, data }): Promise<MonitorBulkResult> =>
      resumeMonitors(context.storage, data.ids)
  );

/** One change to every selected monitor: a channel, the group or a tag. */
export const changeMonitorsFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(monitorChangeInputSchema)
  .handler(
    ({ context, data }): Promise<MonitorBulkResult> =>
      changeMonitors(context.storage, data.ids, data.change)
  );

export const deleteMonitorsFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(monitorIdsSchema)
  .handler(
    ({ context, data }): Promise<MonitorBulkResult> =>
      deleteMonitors(context.storage, data.ids)
  );

export const readMonitorFormFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(monitorFormReadSchema)
  .handler(
    ({ context, data }): Promise<MonitorFormResult> =>
      readMonitorForm(
        context.storage,
        context.boot.installKey,
        data.id,
        new Headers(getRequestHeaders()).get(requestOriginHeader) ?? undefined,
        data.copy
      )
  );

/** The operator's time zone, clock and calendar, for the times and dates the page shows. */
export const readOperatorClockFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<TimeOptions> => readOperatorClock(context.storage)
  );

/** A test is one attempt, so it waits on the network for up to the longest timeout, past Bun's ten idle seconds. */
const testHoldSeconds =
  longestCheckMs({ retries: 0, timeoutMs: timeoutMaxMs }) / 1000 + 10;

export const testMonitorFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(monitorTestSchema)
  .handler(({ context, data }): Promise<MonitorTestResult> => {
    context.holdOpen(testHoldSeconds);
    return testMonitor(
      context.storage,
      context.boot.installKey,
      liveIo(),
      data.input,
      data.id
    );
  });

/** The form's container list: the daemon at the endpoint the form holds, read-only, behind the session like every other function. */
export const listContainersFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(containerListSchema)
  .handler(
    ({ data }): Promise<ContainerListResult> =>
      listContainers(data.endpoint, requestDocker, containerListTimeoutMs)
  );

/** The detail page's read of one monitor, with the chart over the range asked for. */
export const readMonitorDetailFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(monitorDetailReadSchema)
  .handler(
    ({ context, data }): Promise<MonitorDetailResult> =>
      readMonitorDetail(context.storage, data.id, {
        now: Date.now(),
        range: data.range,
        span: data.span,
        requestOrigin:
          new Headers(getRequestHeaders()).get(requestOriginHeader) ??
          undefined,
      })
  );

/** One recent check's failure detail and capture, read when the operator opens it. */
export const readCheckRecordFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(checkRecordReadSchema)
  .handler(
    ({ context, data }): Promise<CheckRecordResult> =>
      readCheckRecord(context.storage, data.id, data.startedAt)
  );

/** "Check now": the scheduler runs the monitor's next check at its next tick. */
export const checkNowFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(checkNowSchema)
  .handler(
    ({ context, data }): Promise<CheckNowResult> =>
      checkNow(context.storage, context.scheduler, data.id)
  );

/** Acknowledges the monitor's open outage, which stops its reminders. */
export const acknowledgeOutageFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(acknowledgeSchema)
  .handler(
    ({ context, data }): Promise<AcknowledgeResult> =>
      acknowledgeOutage(context.storage, context.scheduler, data, Date.now())
  );

/** Dismisses the getting-started checklist for good. */
export const dismissGettingStartedFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<SaveResult> => dismissGettingStarted(context.storage)
  );
