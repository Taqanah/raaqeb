import { describe, expect, test } from "bun:test";
import {
  assignableRoles,
  can,
  manages,
  type Permission,
  permissions,
  type Role,
  roles,
} from "./roles.ts";

/**
 * The role matrix as CONTEXT.md and the docs state it, written out by hand
 * rather than derived from the code: owner, admin, editor, responder,
 * viewer, in that order. A permission added to the code without a row here
 * fails the first test.
 */
const matrix: Readonly<Record<Permission, string>> = {
  read: "OAERV",
  profile: "OAERV",
  check_now: "OAER.",
  acknowledge: "OAER.",
  incidents: "OAER.",
  maintenance: "OAER.",
  monitors: "OAE..",
  pages: "OAE..",
  incidents_delete: "OAE..",
  channels: "OA...",
  settings: "OA...",
  team: "OA...",
  owners: "O....",
  transfer: "O....",
  security: "O....",
};

describe("the role matrix", () => {
  test("names every permission there is, and no other", () => {
    expect(new Set(Object.keys(matrix))).toEqual(new Set(permissions));
  });

  for (const permission of permissions) {
    for (const [index, role] of roles.entries()) {
      const allowed = matrix[permission][index] !== ".";
      test(`${allowed ? "lets" : "keeps"} an operator of the ${role} role ${allowed ? "do" : "from"} ${permission}`, () => {
        expect(can(role, permission)).toBe(allowed);
      });
    }
  }

  test("gives each role everything the role after it has", () => {
    for (const [index, role] of roles.entries()) {
      const next = roles[index + 1];
      if (next === undefined) {
        continue;
      }
      for (const permission of permissions) {
        if (can(next, permission)) {
          expect(can(role, permission)).toBe(true);
        }
      }
    }
  });
});

describe("who manages whose account", () => {
  const managed: Readonly<Record<Role, readonly Role[]>> = {
    owner: ["owner", "admin", "editor", "responder", "viewer"],
    admin: ["admin", "editor", "responder", "viewer"],
    editor: [],
    responder: [],
    viewer: [],
  };
  for (const actor of roles) {
    for (const target of roles) {
      const allowed = managed[actor].includes(target);
      test(`an operator of the ${actor} role ${allowed ? "manages" : "does not manage"} one of the ${target} role`, () => {
        expect(manages(actor, target)).toBe(allowed);
      });
    }
  }

  test("an owner gives any role, an admin any but the owner's, and the others none", () => {
    expect(assignableRoles("owner")).toEqual([...roles]);
    expect(assignableRoles("admin")).toEqual([
      "admin",
      "editor",
      "responder",
      "viewer",
    ]);
    expect(assignableRoles("editor")).toEqual([]);
    expect(assignableRoles("responder")).toEqual([]);
    expect(assignableRoles("viewer")).toEqual([]);
  });
});
