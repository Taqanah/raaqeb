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

/** Whether an operator of `actor` may change, deactivate or remove an operator of `target`: an owner anyone, an admin anyone but an owner. */
export function manages(actor: Role, target: Role): boolean {
  return can(actor, "team") && (target !== "owner" || can(actor, "owners"));
}
