/**
 * The audit log's rules (CONTEXT.md "Audit entry"): which action each
 * admin server function that changes something records, the kinds the log
 * page filters by, and the small, secret-free detail of what was asked. No
 * I/O.
 */
import type { AuditDetail } from "@/shared/schemas/audit.ts";

/** What an entry was done to. */
export const auditTargets = [
  "account",
  "appearance",
  "auth_mail",
  "channel",
  "component",
  "incident",
  "invitation",
  "maintenance",
  "member",
  "metrics",
  "monitor",
  "outage",
  "ownership",
  "page",
  "password",
  "probe",
  "second_step",
  "series",
  "session",
  "settings",
  "sign_in",
  "sso",
  "storage",
  "subscriber",
  "transfer",
] as const;
export type AuditTarget = (typeof auditTargets)[number];

/** What was done to it. */
export const auditVerbs = [
  "acknowledge",
  "change",
  "check",
  "create",
  "deactivate",
  "delete",
  "end",
  "export",
  "import",
  "pause",
  "post",
  "reactivate",
  "refuse",
  "reset",
  "resume",
  "revoke",
  "send",
  "succeed",
  "upload",
] as const;
export type AuditVerb = (typeof auditVerbs)[number];

/** An entry's action: the target, a dot and the verb. */
export type AuditAction = `${AuditTarget}.${AuditVerb}`;

/** The target and verb an action names; nothing for one this version does not know. */
export function actionParts(
  action: string
): { readonly target: AuditTarget; readonly verb: AuditVerb } | undefined {
  const [target, verb] = action.split(".");
  const knownTarget = auditTargets.find((one) => one === target);
  const knownVerb = auditVerbs.find((one) => one === verb);
  return knownTarget && knownVerb
    ? { target: knownTarget, verb: knownVerb }
    : undefined;
}

/**
 * The action each admin server function that changes something records,
 * keyed as its file under src/routes and its name. `-audit.test.ts` reads
 * the source and fails on a POST server function behind a permission that
 * is in neither this table nor `unaudited`.
 */
export const auditedFunctions: Readonly<Record<string, AuditAction>> = {
  "-channels.ts createChannelFn": "channel.create",
  "-channels.ts deleteChannelFn": "channel.delete",
  "-channels.ts editChannelFn": "channel.change",
  "-incidents.ts createIncidentFn": "incident.create",
  "-incidents.ts deleteIncidentFn": "incident.delete",
  "-incidents.ts editIncidentFn": "incident.change",
  "-incidents.ts fixUpdateFn": "incident.change",
  "-incidents.ts postUpdateFn": "incident.post",
  "-maintenance.ts createMaintenanceFn": "maintenance.create",
  "-maintenance.ts createSeriesFn": "series.create",
  "-maintenance.ts deleteMaintenanceFn": "maintenance.delete",
  "-maintenance.ts editMaintenanceFn": "maintenance.change",
  "-maintenance.ts editSeriesFn": "series.change",
  "-maintenance.ts endMaintenanceFn": "maintenance.end",
  "-maintenance.ts endSeriesFn": "series.end",
  "-monitors.ts acknowledgeOutageFn": "outage.acknowledge",
  "-monitors.ts changeMonitorsFn": "monitor.change",
  "-monitors.ts checkNowFn": "monitor.check",
  "-monitors.ts createMonitorFn": "monitor.create",
  "-monitors.ts deleteMonitorsFn": "monitor.delete",
  "-monitors.ts editMonitorFn": "monitor.change",
  "-monitors.ts pauseMonitorsFn": "monitor.pause",
  "-monitors.ts resumeMonitorsFn": "monitor.resume",
  "-pages.ts createComponentFn": "component.create",
  "-pages.ts createPageFn": "page.create",
  "-pages.ts deleteComponentFn": "component.delete",
  "-pages.ts deletePageFn": "page.delete",
  "-pages.ts editComponentFn": "component.change",
  "-pages.ts removePageImageFn": "page.change",
  "-pages.ts removeSubscriberFn": "subscriber.delete",
  "-pages.ts savePageFn": "page.change",
  "-pages.ts uploadPageImageFn": "page.upload",
  "-team.ts changeRoleFn": "member.change",
  "-team.ts deactivateFn": "member.deactivate",
  "-team.ts inviteAgainFn": "invitation.send",
  "-team.ts inviteFn": "invitation.create",
  "-team.ts reactivateFn": "member.reactivate",
  "-team.ts removeFn": "member.delete",
  "-team.ts revokeInvitationFn": "invitation.revoke",
  "-team.ts transferOwnershipFn": "ownership.change",
  "admin/settings/account.tsx changeEmail": "account.change",
  "admin/settings/account.tsx changeName": "account.change",
  "admin/settings/account.tsx changePassword": "password.change",
  "admin/settings/account.tsx endSessions": "session.end",
  "admin/settings/account.tsx saveAccount": "account.change",
  "admin/settings/appearance.tsx save": "appearance.change",
  "admin/settings/index.tsx saveGeneral": "settings.change",
  "admin/settings/locations.tsx make": "probe.create",
  "admin/settings/locations.tsx remove": "probe.delete",
  "admin/settings/locations.tsx renew": "probe.change",
  "admin/settings/metrics.tsx make": "metrics.create",
  "admin/settings/metrics.tsx turnOff": "metrics.delete",
  "admin/settings/sign-in.tsx appOff": "second_step.change",
  "admin/settings/sign-in.tsx change": "second_step.change",
  "admin/settings/sign-in.tsx choose": "auth_mail.change",
  "admin/settings/sign-in.tsx confirm": "second_step.change",
  "admin/settings/sign-in.tsx newCodes": "second_step.change",
  "admin/settings/sign-in.tsx requireSecondStepFn": "second_step.change",
  "admin/settings/sign-in.tsx setUp": "second_step.change",
  "admin/settings/single-sign-on.tsx saveSsoFn": "sso.change",
  "admin/settings/storage.tsx saveStorage": "storage.change",
};

/** The POST server functions that change nothing kept: tests, lookups and a dismissed card. */
export const unaudited: readonly string[] = [
  "-channels.ts sendTestFn",
  "-monitors.ts dismissGettingStartedFn",
  "-monitors.ts listContainersFn",
  "-monitors.ts testMonitorFn",
  "admin/settings/setup-check.tsx checkSetup",
  "admin/settings/sign-in.tsx test",
  "admin/settings/single-sign-on.tsx testDiscoveryFn",
];

// A field whose name says it may hold a secret, or a value too large to be a detail.
const secretName =
  /pass|secret|token|key|credential|code|cookie|auth|values|body|image|content/i;
const detailFields = 12;
const detailLength = 200;

/** What was asked, without secrets: the input's scalar fields by name, a long text cut short, nested values left out. */
export function detailOf(input: unknown): AuditDetail {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }
  const detail: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(input)) {
    if (Object.keys(detail).length >= detailFields || secretName.test(name)) {
      continue;
    }
    if (typeof value === "string") {
      detail[name] = value.slice(0, detailLength);
    } else if (typeof value === "number" || typeof value === "boolean") {
      detail[name] = value;
    }
  }
  return detail;
}

/** The record an input names: its `id`, its `ids` joined, or a page's id; nothing for an install-wide change. */
export function targetOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  if ("id" in input && typeof input.id === "string") {
    return input.id;
  }
  if ("ids" in input && Array.isArray(input.ids)) {
    const ids: unknown[] = input.ids;
    return ids.filter((one) => typeof one === "string").join(",") || null;
  }
  return "pageId" in input && typeof input.pageId === "string"
    ? input.pageId
    : null;
}
