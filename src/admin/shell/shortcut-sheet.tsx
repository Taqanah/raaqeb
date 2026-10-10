/**
 * The shortcut sheet: the keyboard map as a list, opened by `?`
 * or from the palette. Key names are shown as chips in the operator
 * language; the modifier reads Ctrl in its words, or ⌘ once the browser
 * says it is a Mac, after mount.
 */
import type { ReactNode } from "react";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Kbd, KbdGroup } from "@/shared/ui/kbd.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet.tsx";
import {
  keyLabel,
  type Shortcut,
  type ShortcutAction,
  shortcuts,
} from "./keyboard.ts";

const labels: Readonly<Record<ShortcutAction, MessageId>> = {
  close: "app_shortcut_close",
  new_monitor: "app_shortcut_new_monitor",
  palette: "app_shortcut_palette",
  save: "app_shortcut_save",
  search: "app_shortcut_search",
  shortcuts: "app_shortcut_shortcuts",
  sidebar: "app_shortcut_sidebar",
};

export interface ShortcutSheetProps {
  /** Cmd on a Mac, Ctrl elsewhere; the shell reads the platform after mount. */
  readonly modifier: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

export function ShortcutSheet({
  modifier,
  onOpenChange,
  open,
}: ShortcutSheetProps): ReactNode {
  const { locale, t } = useMessages();
  // Escape is a word, through the catalog; a letter or a symbol is the one the operator's keyboard prints.
  const keyName = (shortcut: Shortcut) =>
    shortcut.code === "Escape"
      ? t("app_key_esc")
      : keyLabel(shortcut.code, shortcut.shift, locale);
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent data-slot="shortcut-sheet">
        <SheetHeader>
          <SheetTitle>{t("app_shortcuts")}</SheetTitle>
          <SheetDescription>{t("app_shortcuts_lead")}</SheetDescription>
        </SheetHeader>
        <dl className="mx-5 divide-y">
          {shortcuts.map((shortcut) => (
            <div
              className="flex items-center justify-between gap-4 py-2.5"
              key={shortcut.action}
            >
              <dt>{t(labels[shortcut.action])}</dt>
              <dd>
                <KbdGroup>
                  {shortcut.modifier ? <Kbd>{modifier}</Kbd> : null}
                  <Kbd>{keyName(shortcut)}</Kbd>
                </KbdGroup>
              </dd>
            </div>
          ))}
        </dl>
      </SheetContent>
    </Sheet>
  );
}
