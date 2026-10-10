/**
 * The keyboard map: Ctrl or Cmd+K opens the
 * command palette, Ctrl or Cmd+B toggles the sidebar, Ctrl or Cmd+S saves
 * the form holding the focus, N creates a monitor
 * from the monitor list, `/` focuses search, `?` shows the shortcut sheet,
 * Escape closes. Bindings are physical key codes, so an Arabic layout works.
 * Pure: the shell's hook feeds it key events and acts on the answer.
 */

import type { Locale } from "@/shared/i18n/locale.ts";

export type ShortcutAction =
  | "palette"
  | "sidebar"
  | "save"
  | "new_monitor"
  | "search"
  | "shortcuts"
  | "close";

/** One binding: the physical key code and the modifiers it needs. */
export interface Shortcut {
  readonly action: ShortcutAction;
  readonly code: string;
  /** Ctrl, or Cmd on a Mac. */
  readonly modifier: boolean;
  /** Bare keys (no modifier) only fire outside text fields. */
  readonly outsideFields: boolean;
  readonly shift: boolean;
}

/** The map, in the order the shortcut sheet lists it. */
export const shortcuts: readonly Shortcut[] = [
  {
    action: "palette",
    code: "KeyK",
    modifier: true,
    outsideFields: false,
    shift: false,
  },
  {
    action: "sidebar",
    code: "KeyB",
    modifier: true,
    outsideFields: false,
    shift: false,
  },
  {
    action: "save",
    code: "KeyS",
    modifier: true,
    outsideFields: false,
    shift: false,
  },
  {
    action: "new_monitor",
    code: "KeyN",
    modifier: false,
    outsideFields: true,
    shift: false,
  },
  {
    action: "search",
    code: "Slash",
    modifier: false,
    outsideFields: true,
    shift: false,
  },
  {
    action: "shortcuts",
    code: "Slash",
    modifier: false,
    outsideFields: true,
    shift: true,
  },
  {
    action: "close",
    code: "Escape",
    modifier: false,
    outsideFields: false,
    shift: false,
  },
];

/** The subset of a key event the map reads. */
export interface KeyLike {
  readonly altKey: boolean;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** The action a key event asks for, or nothing; `inField` is whether a text field has focus. */
export function matchShortcut(
  event: KeyLike,
  inField: boolean
): ShortcutAction | undefined {
  if (event.altKey || (event.ctrlKey && event.metaKey)) {
    return;
  }
  const modifier = event.ctrlKey || event.metaKey;
  const found = shortcuts.find(
    (shortcut) =>
      shortcut.code === event.code &&
      shortcut.modifier === modifier &&
      shortcut.shift === event.shiftKey
  );
  if (!found || (found.outsideFields && inField)) {
    return;
  }
  return found.action;
}

/**
 * The name a letter or symbol key shows on its chip:
 * in Arabic, the letter a standard Arabic keyboard prints on that physical
 * key (K reads ن, N reads ى), so the chip names the key the shortcut takes;
 * in English, the Latin one. Words such as Ctrl and Esc go through the
 * catalog instead.
 */
export function keyLabel(code: string, shift: boolean, locale: Locale): string {
  const letter = keyPrefix.test(code) ? code.slice(3) : undefined;
  if (locale === "ar") {
    if (code === "Slash") {
      return shift ? "؟" : "ظ";
    }
    return (letter && arabicLetters[letter]) ?? code;
  }
  if (code === "Slash") {
    return shift ? "?" : "/";
  }
  return letter ?? code;
}

const keyPrefix = /^Key[A-Z]$/;

/** The letters of the standard Arabic keyboard (Arabic 101), by the Latin letter on the same key. */
const arabicLetters: Readonly<Record<string, string>> = {
  A: "ش",
  B: "لا",
  C: "ؤ",
  D: "ي",
  E: "ث",
  F: "ب",
  G: "ل",
  H: "ا",
  I: "ه",
  J: "ت",
  K: "ن",
  L: "م",
  M: "ة",
  N: "ى",
  O: "خ",
  P: "ح",
  Q: "ض",
  R: "ق",
  S: "س",
  T: "ف",
  U: "ع",
  V: "ر",
  W: "ص",
  X: "ء",
  Y: "غ",
  Z: "ئ",
};
