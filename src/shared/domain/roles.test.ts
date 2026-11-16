import { describe, expect, test } from "bun:test";
import {
  allows,
  assignableRoles,
  can,
  keyCan,
  keyRoles,
  lesserRole,
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
  audit: "OA...",
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

describe("what an API key's role allows", () => {
  /** What a key of each role may do, written out by hand: its role's permissions, never the account, the settings, the team, ownership, export and import, or how operators sign in. */
  const everyKeyed: readonly Permission[] = [
    "read",
    "check_now",
    "acknowledge",
    "incidents",
    "maintenance",
    "monitors",
    "pages",
    "incidents_delete",
    "channels",
  ];
  const keyed: Readonly<Record<Role, readonly Permission[]>> = {
    owner: everyKeyed,
    admin: everyKeyed,
    editor: everyKeyed.filter((permission) => permission !== "channels"),
    responder: ["read", "check_now", "acknowledge", "incidents", "maintenance"],
    viewer: ["read"],
  };
  for (const role of roles) {
    test(`a key of the ${role} role may do exactly what the table names`, () => {
      expect(
        permissions.filter((permission) => keyCan(role, permission))
      ).toEqual(
        permissions.filter((permission) => keyed[role].includes(permission))
      );
    });
  }

  test("an account's key may carry its role or any below it, never one above", () => {
    expect(keyRoles("owner")).toEqual([...roles]);
    expect(keyRoles("admin")).toEqual([
      "admin",
      "editor",
      "responder",
      "viewer",
    ]);
    expect(keyRoles("editor")).toEqual(["editor", "responder", "viewer"]);
    expect(keyRoles("responder")).toEqual(["responder", "viewer"]);
    expect(keyRoles("viewer")).toEqual(["viewer"]);
  });

  test("a key whose account fell below its role does what the account's role allows, and one below the account's keeps its own", () => {
    expect(lesserRole("admin", "viewer")).toBe("viewer");
    expect(lesserRole("viewer", "admin")).toBe("viewer");
    expect(lesserRole("editor", "responder")).toBe("responder");
    expect(lesserRole("owner", "owner")).toBe("owner");
  });
});

describe("what a caller may do", () => {
  test("an operator's session does what its role allows", () => {
    expect(allows({ role: "owner" }, "settings")).toBe(true);
    expect(allows({ role: "editor" }, "settings")).toBe(false);
    expect(allows({ role: "viewer" }, "read")).toBe(true);
  });

  test("an API key's call never reaches what only an operator's session may, even with an owner's role", () => {
    expect(allows({ apiKey: {}, role: "owner" }, "settings")).toBe(false);
    expect(allows({ apiKey: {}, role: "owner" }, "monitors")).toBe(true);
    expect(allows({ apiKey: {}, role: "viewer" }, "monitors")).toBe(false);
  });
});
