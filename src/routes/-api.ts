/**
 * The management API's answers (CONTEXT.md "Management API"): the
 * caller's key is read first (server/api/caller.ts), then each operation
 * of shared/api/management.ts calls the admin's own server function, whose
 * permission middleware finds the caller by the request and whose
 * validator parses the same input the admin form posts. Not a route file:
 * the leading dash keeps it out of the route tree.
 */
import type { RequestContext } from "@/handler.ts";
import { matchOperation, pageOfList, refusal } from "@/server/api/answer.ts";
import { callerOfRequest } from "@/server/api/caller.ts";
import {
  type ManagementOperationName,
  managementOperations,
} from "@/shared/api/management.ts";
import { type ApiError, pageQuerySchema } from "@/shared/api/records.ts";
import {
  createChannelFn,
  deleteChannelFn,
  editChannelFn,
  readChannelFormFn,
  readChannelListFn,
  sendTestFn,
} from "./-channels.ts";
import {
  createIncidentFn,
  deleteIncidentFn,
  editIncidentFn,
  fixUpdateFn,
  postUpdateFn,
  readIncidentFn,
  readIncidentListFn,
} from "./-incidents.ts";
import {
  createMaintenanceFn,
  createSeriesFn,
  deleteMaintenanceFn,
  editMaintenanceFn,
  editSeriesFn,
  endMaintenanceFn,
  endSeriesFn,
  readMaintenanceFn,
  readMaintenanceListFn,
  readSeriesFn,
} from "./-maintenance.ts";
import {
  changeMonitorsFn,
  checkNowFn,
  createMonitorFn,
  deleteMonitorsFn,
  editMonitorFn,
  pauseMonitorsFn,
  readMonitorFormFn,
  readMonitorList,
  resumeMonitorsFn,
  testMonitorFn,
  ungroupFn,
} from "./-monitors.ts";
import {
  createComponentFn,
  createPageFn,
  deleteComponentFn,
  deletePageFn,
  editComponentFn,
  readComponentFormFn,
  readComponentListFn,
  readPageEditorFn,
  readPageListFn,
  savePageFn,
} from "./-pages.ts";

/** What an operation's call gets: its path's parameters and the request body as JSON. */
interface Input {
  readonly body: unknown;
  readonly params: Readonly<Record<string, string>>;
}

/** An operation's answer: its record, a page of its list, or a refusal's reason. */
type Outcome =
  | { readonly body?: unknown; readonly ok: true }
  | { readonly ok: false; readonly error: ApiError };

/** A server function's refusal, as every result type spells it. */
interface Refused {
  readonly id?: string;
  readonly ok: false;
  readonly reason: string;
}

function refused(result: Refused): Outcome {
  return {
    error:
      result.id === undefined
        ? { reason: result.reason }
        : { id: result.id, reason: result.reason },
    ok: false,
  };
}

function isDone<R extends { readonly ok: boolean }>(
  result: R
): result is Extract<R, { readonly ok: true }> {
  return result.ok;
}

/** Every result type's refusal names its reason. */
function isRefused(result: { readonly ok: boolean }): result is Refused {
  return !result.ok;
}

/** A server function's result: what `pick` takes of a success, or its refusal. */
function answered<R extends { readonly ok: boolean }>(
  result: R,
  pick: (done: Extract<R, { readonly ok: true }>) => unknown
): Outcome {
  if (isDone(result)) {
    return { body: pick(result), ok: true };
  }
  return isRefused(result)
    ? refused(result)
    : { error: { reason: "unavailable" }, ok: false };
}

/**
 * The request body handed to a server function as its input. This is the
 * API's parse boundary: the server function's validator parses it there,
 * with the admin form's own schema.
 */
function unparsed<Parsed>(body: unknown): Parsed {
  return body as Parsed;
}

/** A removal's result: done, or gone already, which is the same to the caller. */
function gone(result: { readonly ok: true } | Refused): Outcome {
  return result.ok || result.reason === "not_found"
    ? { ok: true }
    : refused(result);
}

/** A pause or a resume of one monitor: done when it changed it or found it so already, not found when there is none. */
async function reached(
  result: { readonly count: number; readonly ok: true } | Refused,
  id: string
): Promise<Outcome> {
  if (!result.ok) {
    return refused(result);
  }
  if (result.count > 0) {
    return { ok: true };
  }
  // None changed: one already paused or running is done all the same, one that does not exist is not found.
  const read = await readMonitorFormFn({ data: { id } });
  return read.ok ? { ok: true } : refused(read);
}

/** A record, or not found when the read answered none. */
function found(record: unknown): Outcome {
  return record === undefined
    ? { error: { reason: "not_found" }, ok: false }
    : { body: record, ok: true };
}

/** A body's field, when the body is an object that has it. */
function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null && name in body
    ? Object.getOwnPropertyDescriptor(body, name)?.value
    : undefined;
}

const param = (input: Input, name: string): string => input.params[name] ?? "";
const ids = (input: Input, name: string) => [param(input, name)];

/** Each operation's call of the admin's server function, and what of its result it answers. */
const calls: {
  readonly [Name in ManagementOperationName]: (
    input: Input
  ) => Promise<Outcome>;
} = {
  listMonitors: async () => {
    const result = await readMonitorList();
    return answered(result, (done) =>
      done.monitors.map((monitor) => ({
        ...monitor,
        state: monitor.paused ? null : (done.states[monitor.id] ?? null),
      }))
    );
  },
  createMonitor: async ({ body }) =>
    answered(
      await createMonitorFn({ data: unparsed(body) }),
      (done) => done.monitor
    ),
  testMonitor: async ({ body }) =>
    answered(
      await testMonitorFn({ data: { input: unparsed(body) } }),
      (done) => done.test
    ),
  readMonitor: async (input) => {
    const result = await readMonitorFormFn({
      data: { id: param(input, "monitorId") },
    });
    if (!result.ok) {
      return refused(result);
    }
    return found(
      result.monitor && {
        ...result.monitor,
        credentials: result.credentials,
        heartbeat: result.heartbeat,
      }
    );
  },
  editMonitor: async (input) =>
    answered(
      await editMonitorFn({
        data: { id: param(input, "monitorId"), input: unparsed(input.body) },
      }),
      (done) => done.monitor
    ),
  deleteMonitor: async (input) =>
    gone(await deleteMonitorsFn({ data: { ids: ids(input, "monitorId") } })),
  testStoredMonitor: async (input) =>
    answered(
      await testMonitorFn({
        data: { id: param(input, "monitorId"), input: unparsed(input.body) },
      }),
      (done) => done.test
    ),
  pauseMonitor: async (input) =>
    reached(
      await pauseMonitorsFn({ data: { ids: ids(input, "monitorId") } }),
      param(input, "monitorId")
    ),
  resumeMonitor: async (input) =>
    reached(
      await resumeMonitorsFn({ data: { ids: ids(input, "monitorId") } }),
      param(input, "monitorId")
    ),
  checkMonitor: async (input) =>
    answered(
      await checkNowFn({ data: { id: param(input, "monitorId") } }),
      ({ answer, from }) => ({ answer, from })
    ),
  listGroups: async () =>
    answered(await readMonitorList(), (done) => {
      const groups = new Map<string, string[]>();
      for (const monitor of done.monitors) {
        if (monitor.group !== undefined) {
          groups.set(monitor.group, [
            ...(groups.get(monitor.group) ?? []),
            monitor.id,
          ]);
        }
      }
      return [...groups]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, monitorIds]) => ({ monitorIds, name }));
    }),
  addToGroup: async (input) => {
    const result = await changeMonitorsFn({
      data: {
        change: { group: param(input, "groupName"), kind: "set_group" },
        ids: unparsed(field(input.body, "monitorIds")),
      },
    });
    return result.ok ? { ok: true } : refused(result);
  },
  deleteGroup: async (input) => {
    const result = await ungroupFn({
      data: { group: param(input, "groupName") },
    });
    return result.ok ? { ok: true } : refused(result);
  },
  listPages: async () =>
    answered(await readPageListFn(), (done) =>
      done.pages.map((item) => ({
        ...item.page,
        components: item.components,
        level: item.level,
      }))
    ),
  createPage: async ({ body }) =>
    answered(await createPageFn({ data: unparsed(body) }), (done) => done.page),
  readPage: async (input) =>
    answered(
      await readPageEditorFn({ data: { id: param(input, "pageId") } }),
      ({ editor }) => ({
        ...editor.page,
        images: editor.images,
        layout: editor.layout,
      })
    ),
  editPage: async (input) =>
    answered(
      await savePageFn({
        data: { id: param(input, "pageId"), input: unparsed(input.body) },
      }),
      (done) => done.page
    ),
  deletePage: async (input) =>
    gone(await deletePageFn({ data: { id: param(input, "pageId") } })),
  listComponents: async () =>
    answered(await readComponentListFn(), (done) =>
      done.components.map((item) => ({
        ...item.component,
        currentStatus: item.status,
      }))
    ),
  createComponent: async ({ body }) =>
    answered(
      await createComponentFn({ data: unparsed(body) }),
      (done) => done.component
    ),
  readComponent: async (input) => {
    const result = await readComponentFormFn({
      data: { id: param(input, "componentId") },
    });
    if (!result.ok) {
      return refused(result);
    }
    const { component, status } = result.form;
    return found(component && { ...component, currentStatus: status });
  },
  editComponent: async (input) =>
    answered(
      await editComponentFn({
        data: { id: param(input, "componentId"), input: unparsed(input.body) },
      }),
      (done) => done.component
    ),
  deleteComponent: async (input) =>
    gone(
      await deleteComponentFn({ data: { id: param(input, "componentId") } })
    ),
  listIncidents: async () =>
    answered(await readIncidentListFn(), (done) => done.list.incidents),
  createIncident: async ({ body }) =>
    answered(
      await createIncidentFn({ data: unparsed(body) }),
      (done) => done.incident
    ),
  readIncident: async (input) =>
    answered(
      await readIncidentFn({ data: { id: param(input, "incidentId") } }),
      (done) => done.page.incident
    ),
  editIncident: async (input) =>
    answered(
      await editIncidentFn({
        data: { id: param(input, "incidentId"), input: unparsed(input.body) },
      }),
      (done) => done.incident
    ),
  deleteIncident: async (input) =>
    gone(await deleteIncidentFn({ data: { id: param(input, "incidentId") } })),
  postUpdate: async (input) =>
    answered(
      await postUpdateFn({
        data: { id: param(input, "incidentId"), input: unparsed(input.body) },
      }),
      (done) => done.incident
    ),
  fixUpdate: async (input) =>
    answered(
      await fixUpdateFn({
        data: {
          id: param(input, "incidentId"),
          message: unparsed(field(input.body, "message")),
          updateId: param(input, "updateId"),
        },
      }),
      (done) => done.incident
    ),
  listMaintenance: async () =>
    answered(await readMaintenanceListFn(), (done) => done.list.windows),
  createMaintenance: async ({ body }) =>
    answered(
      await createMaintenanceFn({ data: unparsed(body) }),
      (done) => done.window
    ),
  readMaintenance: async (input) =>
    answered(
      await readMaintenanceFn({ data: { id: param(input, "windowId") } }),
      (done) => done.page.window
    ),
  editMaintenance: async (input) =>
    answered(
      await editMaintenanceFn({
        data: { id: param(input, "windowId"), input: unparsed(input.body) },
      }),
      (done) => done.window
    ),
  endMaintenance: async (input) =>
    answered(
      await endMaintenanceFn({ data: { id: param(input, "windowId") } }),
      (done) => done.window
    ),
  cancelMaintenance: async (input) =>
    gone(await deleteMaintenanceFn({ data: { id: param(input, "windowId") } })),
  listSeries: async () =>
    answered(await readMaintenanceListFn(), (done) => done.list.series),
  createSeries: async ({ body }) =>
    answered(
      await createSeriesFn({ data: unparsed(body) }),
      (done) => done.series
    ),
  readSeries: async (input) =>
    answered(
      await readSeriesFn({ data: { id: param(input, "seriesId") } }),
      ({ page }) => ({
        ...page.series,
        next: page.next,
        occurrences: page.occurrences,
      })
    ),
  editSeries: async (input) =>
    answered(
      await editSeriesFn({
        data: { id: param(input, "seriesId"), input: unparsed(input.body) },
      }),
      (done) => done.series
    ),
  endSeries: async (input) =>
    gone(await endSeriesFn({ data: { id: param(input, "seriesId") } })),
  listChannels: async () =>
    answered(await readChannelListFn(), (done) =>
      done.channels.map((item) => ({ ...item.channel, summary: item.summary }))
    ),
  createChannel: async ({ body }) =>
    answered(
      await createChannelFn({ data: unparsed(body) }),
      (done) => done.channel
    ),
  readChannel: async (input) =>
    answered(
      await readChannelFormFn({ data: { id: param(input, "channelId") } }),
      // The form's read beside: the generated values, the preview and the recent sends stay the admin's.
      ({ form }) => ({
        ...form.channel,
        kept: form.kept,
        summary: form.summary,
      })
    ),
  editChannel: async (input) =>
    answered(
      await editChannelFn({
        data: { id: param(input, "channelId"), input: unparsed(input.body) },
      }),
      (done) => done.channel
    ),
  deleteChannel: async (input) =>
    gone(await deleteChannelFn({ data: { id: param(input, "channelId") } })),
  testChannel: async (input) =>
    answered(
      await sendTestFn({ data: { id: param(input, "channelId") } }),
      (done) => done.send
    ),
};

/** Where an operation's body sits in its server function's input, so an issue names its place in the body. */
const bodyAt: Partial<Record<ManagementOperationName, string>> = {
  addToGroup: "ids",
  editChannel: "input",
  editComponent: "input",
  editIncident: "input",
  editMaintenance: "input",
  editMonitor: "input",
  editPage: "input",
  editSeries: "input",
  postUpdate: "input",
  testMonitor: "input",
  testStoredMonitor: "input",
};

interface Issue {
  readonly message: string;
  readonly path: (string | number)[];
}

function isIssue(value: unknown): value is Issue {
  const path = field(value, "path");
  return typeof field(value, "message") === "string" && Array.isArray(path);
}

/**
 * The issues a server function's validator refused its input with: Start
 * throws them as an Error whose message is their JSON
 * (start-client-core's `execValidator`); nothing for any other error.
 */
function issuesOf(
  thrown: unknown,
  name: ManagementOperationName
): Issue[] | undefined {
  if (!(thrown instanceof Error)) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(thrown.message);
  } catch {
    return;
  }
  if (!(Array.isArray(parsed) && parsed.every(isIssue))) {
    return;
  }
  const at = bodyAt[name];
  return parsed.map(({ message, path }) => {
    if (name === "addToGroup" && path[0] === "ids") {
      return { message, path: ["monitorIds", ...path.slice(1)] };
    }
    return {
      message,
      path: at !== undefined && path[0] === at ? path.slice(1) : path,
    };
  });
}

/** The request body as JSON; `malformed` when it is not JSON. */
async function bodyOf(
  request: Request
): Promise<
  { readonly ok: true; readonly body: unknown } | { readonly ok: false }
> {
  const text = await request.text();
  if (text === "") {
    return { body: undefined, ok: true };
  }
  try {
    return { body: JSON.parse(text), ok: true };
  } catch {
    return { ok: false };
  }
}

const json = (body: unknown, status: number) =>
  Response.json(body, { headers: { "cache-control": "no-store" }, status });

/** The operation's call: its outcome, or the answer to what its server function threw. */
async function called(
  name: ManagementOperationName,
  input: Input
): Promise<Outcome | Response> {
  try {
    return await calls[name](input);
  } catch (thrown) {
    // The permission middleware refuses with the API's own answer.
    if (thrown instanceof Response) {
      return thrown;
    }
    const issues = issuesOf(thrown, name);
    if (issues) {
      return refusal({ issues, reason: "invalid" });
    }
    throw thrown;
  }
}

/** The answer to a request under `/api/v1/`. */
export async function answerApi(
  context: RequestContext,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  const match = matchOperation(request.method, url.pathname);
  if (!match.ok) {
    return match.reason === "method_not_allowed"
      ? refusal({ reason: match.reason }, { allow: match.allow.join(", ") })
      : refusal({ reason: match.reason });
  }
  // The key first, before anything is read or parsed: a call without a live key costs its one lookup.
  const caller = await callerOfRequest(context.storage, request, Date.now());
  if (!caller.ok) {
    return refusal(
      { reason: caller.reason },
      caller.retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(caller.retryAfterSeconds) }
    );
  }
  const operation = managementOperations[match.name];
  const query =
    "list" in operation
      ? pageQuerySchema.safeParse(Object.fromEntries(url.searchParams))
      : undefined;
  if (query && !query.success) {
    return refusal({
      issues: query.error.issues.map(({ message, path }) => ({
        message,
        path: path.filter((part) => typeof part !== "symbol"),
      })),
      reason: "invalid",
    });
  }
  const read = "body" in operation ? await bodyOf(request) : undefined;
  if (read && !read.ok) {
    return refusal({ reason: "malformed" });
  }
  const outcome = await called(match.name, {
    body: read?.body,
    params: match.params,
  });
  if (outcome instanceof Response) {
    return outcome;
  }
  if (!outcome.ok) {
    return refusal(outcome.error);
  }
  if (operation.status === 204) {
    return new Response(null, { status: 204 });
  }
  if (query?.success && Array.isArray(outcome.body)) {
    return json(pageOfList(outcome.body, query.data), operation.status);
  }
  return json(outcome.body, operation.status);
}
