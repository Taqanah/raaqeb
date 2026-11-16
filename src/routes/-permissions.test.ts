import { describe, expect, test } from "bun:test";
import {
  can,
  type Permission,
  permissions,
  roles,
} from "@/shared/domain/roles.ts";

/**
 * Every server function and every server route handler, and which roles may
 * call it, written out by hand: owner, admin, editor, responder, viewer, in
 * that order, or `public` for one a stranger may call. The source is read
 * for what each actually names, so a new server function or route without a
 * permission, or one whose permission moves, fails here before it reaches a
 * reviewer.
 */
const expected: Readonly<Record<string, string>> = {
  // The shell, the guard and the operator's own account and second step.
  "-admin.ts readSession": "OAERV",
  "admin.tsx readShell": "OAERV",
  "-monitors.ts readOperatorClockFn": "OAERV",
  "admin/settings/account.tsx readAccount": "OAERV",
  "admin/settings/account.tsx saveAccount": "OAERV",
  "admin/settings/account.tsx changeEmail": "OAERV",
  "admin/settings/account.tsx changePassword": "OAERV",
  "admin/settings/account.tsx changeName": "OAERV",
  "admin/settings/account.tsx readSessions": "OAERV",
  "admin/settings/account.tsx endSessions": "OAERV",
  "admin/settings/sign-in.tsx read": "OAERV",
  "admin/settings/sign-in.tsx test": "OAERV",
  "admin/settings/sign-in.tsx change": "OAERV",
  "admin/settings/sign-in.tsx setUp": "OAERV",
  "admin/settings/sign-in.tsx confirm": "OAERV",
  "admin/settings/sign-in.tsx appOff": "OAERV",
  "admin/settings/sign-in.tsx newCodes": "OAERV",
  // Every operator's own API keys; who may revoke another's is the module's to judge.
  "admin/settings/api-keys.tsx read": "OAERV",
  "admin/settings/api-keys.tsx create": "OAERV",
  "admin/settings/api-keys.tsx revoke": "OAERV",
  // Reading the admin area.
  "-monitors.ts readMonitorList": "OAERV",
  "-monitors.ts readMonitorChoicesFn": "OAERV",
  "-monitors.ts readMonitorFormFn": "OAERV",
  "-monitors.ts readMonitorDetailFn": "OAERV",
  "-monitors.ts readSpanChecksFn": "OAERV",
  "-monitors.ts readCheckRecordFn": "OAERV",
  "-pages.ts readComponentListFn": "OAERV",
  "-pages.ts readComponentFormFn": "OAERV",
  "-pages.ts readPageListFn": "OAERV",
  "-pages.ts readInstallLanguageFn": "OAERV",
  "-pages.ts readPageEditorFn": "OAERV",
  "-incidents.ts readIncidentListFn": "OAERV",
  "-incidents.ts readIncidentFn": "OAERV",
  "-maintenance.ts readMaintenanceListFn": "OAERV",
  "-maintenance.ts readMaintenanceFn": "OAERV",
  "-maintenance.ts readSeriesFn": "OAERV",
  "-channels.ts readChannelListFn": "OAERV",
  "-channels.ts readChannelFormFn": "OAERV",
  "admin/monitors/$id/history[.]jsonl[.]zst.ts GET": "OAERV",
  // A report reads the same days the status page shows.
  "-reports.ts readReportChoicesFn": "OAERV",
  "-reports.ts readReportFn": "OAERV",
  "admin/reports/report[.]csv.ts GET": "OAERV",
  // A responder's: answering an outage, incidents and maintenance.
  "-monitors.ts checkNowFn": "OAER.",
  "-monitors.ts acknowledgeOutageFn": "OAER.",
  "-incidents.ts readNewIncidentFn": "OAER.",
  "-incidents.ts createIncidentFn": "OAER.",
  "-incidents.ts editIncidentFn": "OAER.",
  "-incidents.ts postUpdateFn": "OAER.",
  "-incidents.ts fixUpdateFn": "OAER.",
  "-maintenance.ts readNewMaintenanceFn": "OAER.",
  "-maintenance.ts createMaintenanceFn": "OAER.",
  "-maintenance.ts editMaintenanceFn": "OAER.",
  "-maintenance.ts endMaintenanceFn": "OAER.",
  "-maintenance.ts createSeriesFn": "OAER.",
  "-maintenance.ts editSeriesFn": "OAER.",
  "-maintenance.ts endSeriesFn": "OAER.",
  // Deleting a window cancels it while scheduled: scheduling work.
  "-maintenance.ts deleteMaintenanceFn": "OAER.",
  // An editor's: monitors, status pages, components, subscribers, deleting an incident.
  "-monitors.ts createMonitorFn": "OAE..",
  "-monitors.ts editMonitorFn": "OAE..",
  "-monitors.ts pauseMonitorsFn": "OAE..",
  "-monitors.ts resumeMonitorsFn": "OAE..",
  "-monitors.ts changeMonitorsFn": "OAE..",
  "-monitors.ts deleteMonitorsFn": "OAE..",
  "-monitors.ts ungroupFn": "OAE..",
  "-monitors.ts testMonitorFn": "OAE..",
  "-monitors.ts listContainersFn": "OAE..",
  "-monitors.ts dismissGettingStartedFn": "OAE..",
  "-pages.ts createComponentFn": "OAE..",
  "-pages.ts editComponentFn": "OAE..",
  "-pages.ts deleteComponentFn": "OAE..",
  "-pages.ts createPageFn": "OAE..",
  "-pages.ts savePageFn": "OAE..",
  "-pages.ts deletePageFn": "OAE..",
  "-pages.ts uploadPageImageFn": "OAE..",
  "-pages.ts removePageImageFn": "OAE..",
  "-pages.ts readSubscribersFn": "OAE..",
  "-pages.ts removeSubscriberFn": "OAE..",
  "-incidents.ts deleteIncidentFn": "OAE..",
  // An admin's: channels, settings, the team.
  "-channels.ts createChannelFn": "OA...",
  "-channels.ts editChannelFn": "OA...",
  "-channels.ts deleteChannelFn": "OA...",
  "-channels.ts sendTestFn": "OA...",
  // Ending an import's notification hold sends to the channels again.
  "-hold.ts endHoldFn": "OA...",
  "admin/settings/index.tsx readGeneral": "OA...",
  "admin/settings/index.tsx saveGeneral": "OA...",
  "admin/settings/appearance.tsx read": "OA...",
  "admin/settings/appearance.tsx save": "OA...",
  "admin/settings/storage.tsx readStorage": "OA...",
  "admin/settings/storage.tsx saveStorage": "OA...",
  "admin/settings/metrics.tsx read": "OA...",
  "admin/settings/metrics.tsx make": "OA...",
  "admin/settings/metrics.tsx turnOff": "OA...",
  // Probes check from other places with a token each: made and kept like the metrics token.
  "admin/settings/locations.tsx read": "OA...",
  "admin/settings/locations.tsx make": "OA...",
  "admin/settings/locations.tsx renew": "OA...",
  "admin/settings/locations.tsx remove": "OA...",
  "admin/settings/setup-check.tsx checkSetup": "OA...",
  "-team.ts readTeamFn": "OA...",
  "-team.ts inviteFn": "OA...",
  "-team.ts inviteAgainFn": "OA...",
  "-team.ts revokeInvitationFn": "OA...",
  "-team.ts changeRoleFn": "OA...",
  "-team.ts deactivateFn": "OA...",
  "-team.ts reactivateFn": "OA...",
  "-team.ts removeFn": "OA...",
  "admin/audit.tsx readAuditFn": "OA...",
  // An owner's: ownership, export and import, how operators sign in.
  "-team.ts transferOwnershipFn": "O....",
  "admin/settings/export.tsx readSizes": "O....",
  "admin/settings/export.tsx readExportPage": "O....",
  "admin/export.ts GET": "O....",
  "admin/import.ts POST": "O....",
  "admin/settings/sign-in.tsx requireSecondStepFn": "O....",
  // Auth mail carries reset links and codes: the channel it goes through is an owner's to choose.
  "admin/settings/sign-in.tsx choose": "O....",
  "admin/settings/single-sign-on.tsx readSso": "O....",
  "admin/settings/single-sign-on.tsx saveSsoFn": "O....",
  "admin/settings/single-sign-on.tsx testDiscoveryFn": "O....",
  // A stranger's: the document, onboarding, recovery, subscriptions, an invitation.
  "__root.tsx readDocument": "public",
  "design.tsx readSampleCatalog": "public",
  "reset-password.tsx readLink": "public",
  "invitation.tsx readInvitationFn": "public",
  "-auth-mail.ts hasAuthEmail": "public",
  "-sso.ts readSsoOfferFn": "public",
  "-onboarding.ts readOnboardingStep": "public",
  "-onboarding.ts readOnboarding": "public",
  "onboarding/account.tsx suggestAddress": "public",
  "onboarding/account.tsx create": "public",
  "onboarding/database.tsx testUrl": "public",
  "onboarding/database.tsx choose": "public",
  "-subscriptions.ts subscribeFn": "public",
  "-subscriptions.ts readSubscriptionPageFn": "public",
  // A stranger's server routes: sign-in itself, health and metrics (each with its own token check), the public pages' feeds, badges and JSON, a heartbeat, a subscriber's links, a custom domain's check.
  "api/auth/$.ts GET": "public",
  "api/auth/$.ts POST": "public",
  "health.ts GET": "public",
  "metrics.ts GET": "public",
  // The management API: its key is read first, then each operation's server function above checks its own permission.
  "api/v1/$.ts ANY": "public",
  "api/openapi[.]json.ts GET": "public",
  "api/custom-domain.ts GET": "public",
  "api/custom-domain.ts HEAD": "public",
  "api/heartbeat/$token/index.ts GET": "public",
  "api/heartbeat/$token/index.ts HEAD": "public",
  "api/heartbeat/$token/index.ts POST": "public",
  "api/heartbeat/$token/fail.ts GET": "public",
  "api/heartbeat/$token/fail.ts HEAD": "public",
  "api/heartbeat/$token/fail.ts POST": "public",
  // A probe, with its own bearer token.
  "api/probe/v1/assignments.ts GET": "public",
  "api/probe/v1/results.ts POST": "public",
  "api/v2/summary[.]json.ts GET": "public",
  "api/v2/summary[.]json.ts HEAD": "public",
  "status/$slug/api/v2/summary[.]json.ts GET": "public",
  "status/$slug/api/v2/summary[.]json.ts HEAD": "public",
  "{-$locale}/feed[.]atom.ts GET": "public",
  "{-$locale}/feed[.]atom.ts HEAD": "public",
  "{-$locale}/badge[.]svg.ts GET": "public",
  "{-$locale}/badge[.]svg.ts HEAD": "public",
  "{-$locale}/status/$slug/feed[.]atom.ts GET": "public",
  "{-$locale}/status/$slug/feed[.]atom.ts HEAD": "public",
  "{-$locale}/status/$slug/badge[.]svg.ts GET": "public",
  "{-$locale}/status/$slug/badge[.]svg.ts HEAD": "public",
  "subscriptions/$token/confirm.ts GET": "public",
  "subscriptions/$token/confirm.ts POST": "public",
  "subscriptions/$token/unsubscribe.ts GET": "public",
  "subscriptions/$token/unsubscribe.ts POST": "public",
  "api/pages/$id/overview.ts GET": "public",
  "api/pages/$id/overview.ts HEAD": "public",
  // A published page's data; an unpublished one's answers an operator's preview alone (isOperator).
  "api/pages/$id/$kind.ts GET": "public",
  "api/pages/$id/$kind.ts HEAD": "public",
  "api/pages/$id/maintenance/$windowId.ts GET": "public",
  "api/pages/$id/maintenance/$windowId.ts HEAD": "public",
  "api/pages/$id/incidents/$incidentId.ts GET": "public",
  "api/pages/$id/incidents/$incidentId.ts HEAD": "public",
  "api/pages/$id/history/index.ts GET": "public",
  "api/pages/$id/history/index.ts HEAD": "public",
  "api/pages/$id/history/$month.ts GET": "public",
  "api/pages/$id/history/$month.ts HEAD": "public",
};

const routes = `${import.meta.dir}`;
const declaration = /const (\w+) = createServerFn\(/g;
const renamed = /createServerFn as /;
const permittedCall = /^\s*\.middleware\(\[permitted\("(\w+)"\)\]\)/;
// A check counts only when its answer decides: the operator it returns is bound and a missing one turns the request away.
const routeCheck =
  /const (\w+) = await signedIn\(context, request, "(\w+)"\);\s*if \(!\1\)/;
// Start answers a request by `handlers[method]`, so every name it could read is looked up, own or inherited, enumerable or not.
const httpMethods = [
  "ANY",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
];

/** A server route handler: its compiled source, and a call as the entry makes it with a context the test builds by hand. */
interface Handler {
  readonly call: (arguments_: {
    context: object;
    params: Record<string, string>;
    request: Request;
  }) => Promise<unknown>;
  readonly source: string;
}

/** The named property of an object, or nothing. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, name)
    : undefined;
}

/** Every source file under the routes, tests left out. */
async function sources(): Promise<string[]> {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: routes })
  );
  return files.filter((one) => !one.includes(".test."));
}

/** Every property name the object or its prototypes carry, enumerable or not. */
function namesOf(value: object): string[] {
  const names: string[] = [];
  for (
    let level: object | null = value;
    level !== null && level !== Object.prototype;
    level = Reflect.getPrototypeOf(level)
  ) {
    names.push(...Object.getOwnPropertyNames(level));
  }
  return names;
}

/** Each server route handler by `file METHOD`, read from the route module the way Start reads it, by method name. */
async function routeHandlers(): Promise<Map<string, Handler>> {
  const found = new Map<string, Handler>();
  for (const file of await sources()) {
    // biome-ignore lint/performance/noAwaitInLoops: a few dozen modules, imported once
    const module: Record<string, unknown> = await import(`${routes}/${file}`);
    const handlers = field(
      field(field(module.Route, "options"), "server"),
      "handlers"
    );
    if (handlers === undefined) {
      continue;
    }
    // The function form builds its handlers when called, out of this test's sight.
    if (typeof handlers !== "object" || handlers === null) {
      throw new Error(`${file}: its handlers are not an object`);
    }
    for (const method of new Set([...httpMethods, ...namesOf(handlers)])) {
      const handler: unknown = Reflect.get(handlers, method);
      if (handler === undefined) {
        continue;
      }
      if (typeof handler !== "function") {
        throw new Error(`${file} ${method} is not a function`);
      }
      found.set(`${file} ${method}`, {
        call: async (arguments_) =>
          Reflect.apply(handler, undefined, [arguments_]),
        source: String(handler),
      });
    }
  }
  return found;
}

/** What the source names: each server function's permission, or `public` when it carries none, and each server route handler's, `public` when its own code checks no session. */
async function named(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const file of await sources()) {
    // biome-ignore lint/performance/noAwaitInLoops: a few dozen files, read once
    const text = await Bun.file(`${routes}/${file}`).text();
    const calls = text.split("createServerFn(").length - 1;
    const names = [...text.matchAll(declaration)];
    // A server function not assigned to a name of its own could not be looked up here.
    expect(`${file}: ${names.length}`).toBe(`${file}: ${calls}`);
    // Under another name a server function would not be counted at all.
    expect(`${file}: ${renamed.test(text)}`).toBe(`${file}: false`);
    for (const match of names) {
      const after = text.slice((match.index ?? 0) + match[0].length);
      const chain = after.slice(after.indexOf(")") + 1);
      const permission = permittedCall.exec(chain)?.[1] ?? "public";
      found.set(`${file} ${match[1]}`, permission);
    }
  }
  // A handler's own compiled code, comments gone, so a check another handler or a comment makes is never credited to it.
  for (const [key, handler] of await routeHandlers()) {
    found.set(key, routeCheck.exec(handler.source)?.[2] ?? "public");
  }
  return found;
}

const letters = "OAERV";

function knownPermission(name: string): Permission | undefined {
  return permissions.find((one) => one === name);
}

describe("every server function's permission", () => {
  test("is named in the source as this table expects, and the table names every one", async () => {
    const found = await named();
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...found.keys()].toSorted(byName)).toEqual(
      Object.keys(expected).toSorted(byName)
    );
    for (const [key, permission] of found) {
      if (permission === "public") {
        expect(`${key}: ${expected[key]}`).toBe(`${key}: public`);
      } else {
        expect(`${key}: ${knownPermission(permission) !== undefined}`).toBe(
          `${key}: true`
        );
      }
    }
  });

  test("is read for every server function, since each lives under the routes", async () => {
    const src = `${routes}/..`;
    const files = await Array.fromAsync(
      new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: src })
    );
    const read = files.filter(
      (file) => !(file.startsWith("routes/") || file.includes(".test."))
    );
    const texts = await Promise.all(
      read.map((file) => Bun.file(`${src}/${file}`).text())
    );
    const outside = read.filter((_, at) =>
      texts[at]?.includes("createServerFn")
    );
    expect(outside).toEqual([]);
  });

  test("is never public for a server function or route under the admin area", async () => {
    const found = await named();
    const exposed = [...found]
      .filter(
        ([key, permission]) =>
          key.startsWith("admin") && permission === "public"
      )
      .map(([key]) => key);
    expect(exposed).toEqual([]);
  });

  test("lets exactly the roles the table names call each one", async () => {
    const found = await named();
    for (const [key, permission] of found) {
      const shape = expected[key] ?? "";
      if (permission === "public" || shape === "public") {
        continue;
      }
      const known = knownPermission(permission);
      const allowed = roles
        .map((role, index) =>
          known && can(role, known) ? letters[index] : "."
        )
        .join("");
      expect(`${key}: ${allowed}`).toBe(`${key}: ${shape}`);
    }
  });

  test("refuses every server route that names a permission to a stranger's request, cookie or not, before it reads anything", async () => {
    const guarded = [...(await routeHandlers())].filter(
      ([key]) => expected[key] !== "public"
    );
    // A stranger sends no cookie, or one that names no session.
    const strangers: Record<string, string>[] = [
      {},
      { cookie: "raaqeb.session_token=not-a-session" },
    ];
    const asked = guarded.flatMap(([key, handler]) =>
      strangers.map((headers) => ({ handler, headers, key }))
    );
    const answers = await Promise.all(
      asked.map(async ({ handler, headers, key }) => {
        const label = `${key} ${headers.cookie ? "with" : "without"} a cookie`;
        // No storage: a handler that went past its check would throw on the first read.
        const answer = await handler.call({
          context: {
            boot: {},
            holdOpen: () => undefined,
            scheduler: undefined,
            storage: undefined,
          },
          params: { id: "x" },
          request: new Request("http://127.0.0.1/", {
            headers,
            method: key.endsWith(" POST") ? "POST" : "GET",
          }),
        });
        if (!(answer instanceof Response)) {
          return `${label}: not a response`;
        }
        const location = answer.headers.get("location");
        const refused =
          (answer.status === 401 ||
            (answer.status === 303 &&
              location !== null &&
              new URL(location).pathname === "/sign-in")) &&
          (await answer.text()) === "";
        return `${label}: ${refused ? "refused" : answer.status}`;
      })
    );
    expect(answers).toEqual(
      asked.map(
        ({ headers, key }) =>
          `${key} ${headers.cookie ? "with" : "without"} a cookie: refused`
      )
    );
  });
});
