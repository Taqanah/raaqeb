import { describe, expect, test } from "bun:test";
import {
  type KeyLike,
  keyLabel,
  matchShortcut,
  shortcuts,
} from "./keyboard.ts";

function key(partial: Partial<KeyLike> & { code: string }): KeyLike {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("the keyboard map", () => {
  test("lists the seven bindings in the order the shortcut sheet shows them", () => {
    expect(shortcuts.map((shortcut) => shortcut.action)).toEqual([
      "palette",
      "sidebar",
      "save",
      "new_monitor",
      "search",
      "shortcuts",
      "close",
    ]);
  });

  test("Ctrl or Cmd with the physical K key opens the command palette, wherever the focus is", () => {
    expect(matchShortcut(key({ code: "KeyK", ctrlKey: true }), false)).toBe(
      "palette"
    );
    expect(matchShortcut(key({ code: "KeyK", metaKey: true }), true)).toBe(
      "palette"
    );
    expect(matchShortcut(key({ code: "KeyK" }), false)).toBeUndefined();
  });

  test("Ctrl or Cmd with the physical B key toggles the sidebar", () => {
    expect(matchShortcut(key({ code: "KeyB", ctrlKey: true }), true)).toBe(
      "sidebar"
    );
  });

  test("Ctrl or Cmd with the physical S key saves, in a field or out of it", () => {
    expect(matchShortcut(key({ code: "KeyS", ctrlKey: true }), true)).toBe(
      "save"
    );
    expect(matchShortcut(key({ code: "KeyS", metaKey: true }), false)).toBe(
      "save"
    );
    expect(matchShortcut(key({ code: "KeyS" }), false)).toBeUndefined();
    expect(
      matchShortcut(key({ code: "KeyS", ctrlKey: true, shiftKey: true }), true)
    ).toBeUndefined();
  });

  test("the bare N, slash and question mark fire outside text fields only", () => {
    expect(matchShortcut(key({ code: "KeyN" }), false)).toBe("new_monitor");
    expect(matchShortcut(key({ code: "KeyN" }), true)).toBeUndefined();
    expect(matchShortcut(key({ code: "Slash" }), false)).toBe("search");
    expect(matchShortcut(key({ code: "Slash" }), true)).toBeUndefined();
    expect(matchShortcut(key({ code: "Slash", shiftKey: true }), false)).toBe(
      "shortcuts"
    );
    expect(
      matchShortcut(key({ code: "Slash", shiftKey: true }), true)
    ).toBeUndefined();
  });

  test("Escape closes, in a field or out of it", () => {
    expect(matchShortcut(key({ code: "Escape" }), true)).toBe("close");
    expect(matchShortcut(key({ code: "Escape" }), false)).toBe("close");
  });

  test("a binding is physical: the code decides, so an Arabic layout works; an extra modifier is another chord", () => {
    expect(
      matchShortcut(key({ code: "KeyN", ctrlKey: true }), false)
    ).toBeUndefined();
    expect(
      matchShortcut(key({ code: "KeyK", ctrlKey: true, altKey: true }), false)
    ).toBeUndefined();
    expect(
      matchShortcut(key({ code: "KeyK", ctrlKey: true, shiftKey: true }), false)
    ).toBeUndefined();
  });
});

describe("a key's name on its chip", () => {
  test("in Arabic is the letter an Arabic keyboard prints on the same key", () => {
    expect(keyLabel("KeyK", false, "ar")).toBe("ن");
    expect(keyLabel("KeyN", false, "ar")).toBe("ى");
    expect(keyLabel("KeyB", false, "ar")).toBe("لا");
    expect(keyLabel("Slash", false, "ar")).toBe("ظ");
    expect(keyLabel("Slash", true, "ar")).toBe("؟");
  });

  test("in English is the Latin letter or symbol", () => {
    expect(keyLabel("KeyK", false, "en")).toBe("K");
    expect(keyLabel("KeyN", false, "en")).toBe("N");
    expect(keyLabel("Slash", false, "en")).toBe("/");
    expect(keyLabel("Slash", true, "en")).toBe("?");
  });

  test("every key the map binds has a name in both languages", () => {
    for (const shortcut of shortcuts.filter((each) => each.code !== "Escape")) {
      for (const locale of ["ar", "en"] as const) {
        expect(keyLabel(shortcut.code, shortcut.shift, locale)).not.toBe(
          shortcut.code
        );
      }
    }
  });
});
