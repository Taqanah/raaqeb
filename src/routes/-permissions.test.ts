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
  // An owner's: ownership, export and import, how operators sign in.
  "-team.ts transferOwnershipFn": "O....",
  "admin/settings/export.tsx readSizes": "O....",
  "admin/settings/export.tsx readExportPage": "O....",
  "admin/export.ts GET": "O....",
  "admin/import.ts POST": "O....",
  "admin/settings/sign-in.tsx requireSecondStepFn": "O....",
  // Auth mail carries reset links and codes: the channel it goes through is an owner's to choose.
  "admin/settings/sign-in.tsx choose": "O....",
  // A stranger's: the document, onboarding, recovery, subscriptions, an invitation.
  "__root.tsx readDocument": "public",
  "design.tsx readSampleCatalog": "public",
  "reset-password.tsx readLink": "public",
  "invitation.tsx readInvitationFn": "public",
  "-auth-mail.ts hasAuthEmail": "public",
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
const permittedCall = /^\s*\.middleware\(\[permitted\("(\w+)"\)\]\)/;
// Every method a server route's `handlers` answers, and the session check its handler makes.
const handlerKey = /^\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|ANY):/gm;
const routeCheck = /signedIn\(context, request, "(\w+)"\)/;

/** What the source names: each server function's permission, or `public` when it carries none, and each server route handler's, `public` when it checks no session. */
async function named(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: routes })
  );
  for (const file of files.filter((one) => !one.includes(".test."))) {
    // biome-ignore lint/performance/noAwaitInLoops: a few dozen files, read once
    const text = await Bun.file(`${routes}/${file}`).text();
    const calls = text.split("createServerFn(").length - 1;
    const names = [...text.matchAll(declaration)];
    // A server function not assigned to a name of its own could not be looked up here.
    expect(`${file}: ${names.length}`).toBe(`${file}: ${calls}`);
    for (const match of names) {
      const after = text.slice((match.index ?? 0) + match[0].length);
      const chain = after.slice(after.indexOf(")") + 1);
      const permission = permittedCall.exec(chain)?.[1] ?? "public";
      found.set(`${file} ${match[1]}`, permission);
    }
    const handlers = [...text.matchAll(handlerKey)];
    for (const [index, match] of handlers.entries()) {
      // A handler runs to the next one, the last to the file's end.
      const body = text.slice(match.index, handlers[index + 1]?.index);
      found.set(`${file} ${match[1]}`, routeCheck.exec(body)?.[1] ?? "public");
    }
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
});
