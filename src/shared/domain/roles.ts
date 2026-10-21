/**
 * Roles and what each lets an operator do (CONTEXT.md "Role"): one fixed
 * table, read by every server function's permission check and by the admin
 * UI, which hides or disables what the operator's role does not allow. No
 * I/O.
 */

/** The five roles, most powerful first. */
export const roles = [
  "owner",
  "admin",
  "editor",
  "responder",
  "viewer",
] as const;
export type Role = (typeof roles)[number];

/**
 * What a server function or a route needs. `read` opens the monitors, status
 * pages, components, incidents, maintenance and channels; `profile` is an
 * operator's own account and second step.
 */
export const permissions = [
  "read",
  "profile",
  "check_now",
  "acknowledge",
  "incidents",
  "maintenance",
  "monitors",
  "pages",
  "incidents_delete",
  "channels",
  "settings",
  "team",
  "audit",
  "owners",
  "transfer",
  "security",
] as const;
export type Permission = (typeof permissions)[number];

/** What each role adds to the role after it; the viewer's are its own. */
const added: Readonly<Record<Role, readonly Permission[]>> = {
  owner: ["owners", "transfer", "security"],
  admin: ["channels", "settings", "team", "audit"],
  editor: ["monitors", "pages", "incidents_delete"],
  responder: ["check_now", "acknowledge", "incidents", "maintenance"],
  viewer: ["read", "profile"],
};

/** Each role's permissions: its own and every one of the roles after it. */
const granted: ReadonlyMap<Role, ReadonlySet<Permission>> = new Map(
  roles.map((role, index) => [
    role,
    new Set(roles.slice(index).flatMap((below) => added[below])),
  ])
);

/** Whether an operator of the role may do what the permission names. */
export function can(role: Role, permission: Permission): boolean {
  return granted.get(role)?.has(permission) ?? false;
}

/** The roles an operator of `actor` may give another operator, or invite one as. */
export function assignableRoles(actor: Role): readonly Role[] {
  return roles.filter((role) => manages(actor, role));
}

/** The lesser of two roles: what a key does when its account's role is below the key's. */
export function lesserRole(a: Role, b: Role): Role {
  return roles.indexOf(a) > roles.indexOf(b) ? a : b;
}

/** The roles an API key of an account of `role` may carry: that role and every one below it. */
export function keyRoles(role: Role): readonly Role[] {
  return roles.slice(roles.indexOf(role));
}

/** What no API key reaches, whatever its role. */
const keyless: ReadonlySet<Permission> = new Set([
  "audit",
  "profile",
  "settings",
  "team",
  "owners",
  "transfer",
  "security",
]);

/** Whether an API key of the role may do what the permission names: what the role allows, but never the account itself, the settings, the team, ownership, export and import, the audit log, nor how operators sign in. */
export function keyCan(role: Role, permission: Permission): boolean {
  return !keyless.has(permission) && can(role, permission);
}

/** Whether a caller may do what the permission names: an operator what their role allows, an API key's call what a key of its role does. */
export function allows(
  caller: { readonly apiKey?: unknown; readonly role: Role },
  permission: Permission
): boolean {
  return (caller.apiKey === undefined ? can : keyCan)(caller.role, permission);
}

/** Whether an operator of `actor` may change, deactivate or remove an operator of `target`: an owner anyone, an admin anyone but an owner. */
export function manages(actor: Role, target: Role): boolean {
  return can(actor, "team") && (target !== "owner" || can(actor, "owners"));
}
