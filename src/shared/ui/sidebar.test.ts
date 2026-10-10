import { describe, expect, test } from "bun:test";
import { sidebarOpenFromCookie } from "./sidebar.tsx";

describe("the sidebar's remembered state", () => {
  test("is open on a first visit and whenever the cookie says nothing", () => {
    expect(sidebarOpenFromCookie(undefined)).toBe(true);
    expect(sidebarOpenFromCookie(null)).toBe(true);
    expect(sidebarOpenFromCookie("")).toBe(true);
    expect(sidebarOpenFromCookie("raaqeb.session_token=abc")).toBe(true);
  });

  test("is closed only when the cookie says so, wherever it sits among the others", () => {
    expect(sidebarOpenFromCookie("sidebar_state=false")).toBe(false);
    expect(sidebarOpenFromCookie("a=b; sidebar_state=false; c=d")).toBe(false);
    expect(sidebarOpenFromCookie("a=b; sidebar_state=true")).toBe(true);
    expect(sidebarOpenFromCookie("other_sidebar_state=false")).toBe(true);
  });
});
