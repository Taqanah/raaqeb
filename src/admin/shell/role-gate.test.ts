import { describe, expect, test } from "bun:test";
import { formPermissionOf } from "./role-gate.ts";

describe("what changing a page's record needs", () => {
  test("is the record's own permission on its form and editor pages", () => {
    expect(formPermissionOf("/admin/monitors/new")).toBe("monitors");
    expect(formPermissionOf("/admin/monitors/m1/edit")).toBe("monitors");
    expect(formPermissionOf("/admin/pages/p1")).toBe("pages");
    expect(formPermissionOf("/admin/pages/new")).toBe("pages");
    expect(formPermissionOf("/admin/components/c1")).toBe("pages");
    expect(formPermissionOf("/admin/incidents/i1")).toBe("incidents");
    expect(formPermissionOf("/admin/maintenance/w1")).toBe("maintenance");
    expect(formPermissionOf("/admin/maintenance/series/s1")).toBe(
      "maintenance"
    );
    expect(formPermissionOf("/admin/channels/c1/")).toBe("channels");
  });

  test("is nothing for a list, a monitor's detail, whose actions each say theirs, or a settings page", () => {
    expect(formPermissionOf("/admin/monitors")).toBeUndefined();
    expect(formPermissionOf("/admin/monitors/m1")).toBeUndefined();
    expect(formPermissionOf("/admin/pages")).toBeUndefined();
    expect(formPermissionOf("/admin/pages/p1/subscribers")).toBeUndefined();
    expect(formPermissionOf("/admin/settings/account")).toBeUndefined();
    expect(formPermissionOf("/admin/team")).toBeUndefined();
  });
});
