/**
 * The shell's side of the keyboard map: one document listener
 * that hands every key down to `matchShortcut` and calls the handler the
 * shell gave for the action. Bound in an effect after mount, so the server
 * render never touches the document.
 */
import { useEffect } from "react";
import { matchShortcut, type ShortcutAction } from "./keyboard.ts";

export type ShortcutHandlers = Readonly<
  Partial<Record<ShortcutAction, () => void>>
>;

/** Whether the focused element takes typed text or letter typeahead (a select or menu trigger), where bare keys must not fire. */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable ||
    target.hasAttribute("aria-haspopup") ||
    target.closest("[role=listbox],[role=menu],[role=combobox]") !== null
  );
}

export function useKeyboard(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = matchShortcut(event, inTextField(event.target));
      const handler = action ? handlers[action] : undefined;
      if (!handler) {
        return;
      }
      event.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}
