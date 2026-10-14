/**
 * The command palette: Ctrl or Cmd+K opens a dialog holding an
 * always-open Base UI Autocomplete over every admin page and the actions of
 * `navigation.ts`; typing filters, Enter or a click runs the highlighted one.
 * It is the search too: once the query has text it lists the monitors
 * it finds, under the monitor list's own search rule, and a row opening the
 * list searched for it. The monitors are read each time it opens, through
 * one cheap query. Built on the pattern of Base UI's own command-palette demo
 * (docs/deps/base-ui, components/autocomplete/demos/command-palette), with
 * no cmdk.
 */
import { Autocomplete } from "@base-ui/react/autocomplete";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  MonitorChoice,
  MonitorChoicesResult,
} from "@/shared/schemas/monitor.ts";
import { cn } from "@/shared/ui/cn.ts";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog.tsx";
import { type IconProps, SearchIcon } from "@/shared/ui/icons.tsx";
import { Kbd } from "@/shared/ui/kbd.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { keyLabel } from "./keyboard.ts";
import { navIcons } from "./nav-icons.ts";
import { type PaletteItem, paletteGroups } from "./navigation.ts";

interface Entry {
  readonly item: PaletteItem;
  readonly label: string;
  readonly value: string;
}

interface Group {
  readonly items: readonly Entry[];
  readonly label: string;
  readonly value: string;
}

/** A row's icon: a page's or an action's own, a monitor's as in the sidebar, the search glass for the list searched. */
function iconOf(item: PaletteItem): (props: IconProps) => ReactNode {
  switch (item.kind) {
    case "page":
      return navIcons[item.item.icon];
    case "action":
      return navIcons[item.action];
    case "monitor":
      return navIcons.monitors;
    default:
      return SearchIcon;
  }
}

/** One row: Enter on the highlighted row and a click both land on `onClick`. */
function PaletteEntry({
  choose,
  entry,
}: {
  readonly choose: (entry: Entry) => void;
  readonly entry: Entry;
}): ReactNode {
  const { locale } = useMessages();
  const onClick = useCallback(() => choose(entry), [choose, entry]);
  const Icon = iconOf(entry.item);
  return (
    <Autocomplete.Item
      className={cn(
        "flex h-control cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:size-icon [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        // Sign out is red here as in the sidebar's footer.
        entry.value === "sign_out" &&
          "text-destructive-text data-highlighted:bg-destructive/10 data-highlighted:text-destructive-text [&_svg]:text-destructive-text"
      )}
      data-palette-item={entry.value}
      onClick={onClick}
      value={entry}
    >
      <Icon />
      {/* A monitor's name may be in the other language: in its own direction the ellipsis falls at its end. */}
      <span className="truncate" dir="auto">
        {entry.label}
      </span>
      {/* The target shows why a monitor matched when the query was part of its URL. */}
      {entry.item.kind === "monitor" && entry.item.monitor.target ? (
        <Token className="ms-auto min-w-0 truncate bg-transparent px-0 text-muted-foreground text-xs">
          {entry.item.monitor.target}
        </Token>
      ) : null}
      {/* Its key works on every page; N works on the monitor list only, so it shows no chip. */}
      {entry.value === "shortcuts" ? (
        <Kbd aria-hidden="true" className="ms-auto pointer-coarse:hidden">
          {keyLabel("Slash", true, locale)}
        </Kbd>
      ) : null}
    </Autocomplete.Item>
  );
}

export interface PaletteProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (item: PaletteItem) => void;
  readonly open: boolean;
  /** Every monitor's name and target, read each time the palette opens; nothing when the session check redirected. */
  readonly readMonitors: () => Promise<MonitorChoicesResult | undefined>;
}

export function Palette({
  onOpenChange,
  onSelect,
  open,
  readMonitors,
}: PaletteProps): ReactNode {
  const { t } = useMessages();
  const choose = useCallback(
    (entry: Entry) => {
      onOpenChange(false);
      onSelect(entry.item);
    },
    [onOpenChange, onSelect]
  );
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-label={t("app_palette_title")}
        className="top-[15%] -translate-y-0 gap-0 p-0 sm:max-w-lg"
        data-slot="palette"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t("app_palette_title")}</DialogTitle>
        {/* Mounted while open only, so each opening starts empty and reads the monitors again. */}
        <PaletteSearch choose={choose} readMonitors={readMonitors} />
      </DialogContent>
    </Dialog>
  );
}

function PaletteSearch({
  choose,
  readMonitors,
}: {
  readonly choose: (entry: Entry) => void;
  readonly readMonitors: () => Promise<MonitorChoicesResult | undefined>;
}): ReactNode {
  const { locale, t } = useMessages();
  const [query, setQuery] = useState("");
  const [monitors, setMonitors] = useState<readonly MonitorChoice[]>([]);
  useEffect(() => {
    let mounted = true;
    // A failed read leaves no monitor rows; the list searched still finds them.
    readMonitors()
      .then((result) => {
        // When the session check redirects, useServerFn navigates and answers nothing (useServerFn.js in @tanstack/react-start).
        if (mounted && result?.ok) {
          setMonitors(result.monitors);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [readMonitors]);
  const groups = useMemo<readonly Group[]>(
    () =>
      paletteGroups(query, monitors, locale).map((group) => ({
        items: group.items.map((item) => ({
          item,
          label: labelOf(item, t),
          value: item.kind === "page" ? item.item.id : item.id,
        })),
        label: t(group.label),
        value: group.id,
      })),
    [locale, monitors, query, t]
  );
  const { contains } = Autocomplete.useFilter();
  // The monitor rows are already the list's search rule's answer, and the list searched is always offered.
  const filter = useCallback(
    (entry: Entry, text: string) =>
      entry.item.kind === "monitor" ||
      entry.item.kind === "search" ||
      contains(entry.label, text),
    [contains]
  );
  return (
    <Autocomplete.Root
      autoHighlight="always"
      filter={filter}
      inline
      items={groups}
      keepHighlight
      onValueChange={setQuery}
      open
      value={query}
    >
      <Autocomplete.InputGroup className="flex h-control items-center gap-2 border-b px-3">
        <SearchIcon className="size-icon shrink-0 text-muted-foreground" />
        <Autocomplete.Input
          aria-label={t("app_palette_placeholder")}
          autoFocus
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          data-slot="palette-input"
          placeholder={t("app_palette_placeholder")}
        />
        {/* A phone has no Esc key, as with the "?" chip. */}
        <Kbd className="pointer-coarse:hidden">{t("app_key_esc")}</Kbd>
      </Autocomplete.InputGroup>
      <div className="max-h-[min(36rem,70vh)] overflow-y-auto p-1">
        <Autocomplete.Empty className="px-2 py-6 text-center text-muted-foreground text-sm empty:hidden">
          {t("app_palette_empty")}
        </Autocomplete.Empty>
        <Autocomplete.List>
          {(group: Group) => (
            <Autocomplete.Group
              className="py-1"
              items={group.items}
              key={group.value}
            >
              {/* A group of one needs no heading, as in the sidebar. */}
              {group.items.length > 1 ? (
                <Autocomplete.GroupLabel className="px-2 py-1 text-muted-foreground text-xs">
                  {group.label}
                </Autocomplete.GroupLabel>
              ) : null}
              <Autocomplete.Collection>
                {(entry: Entry) => (
                  <PaletteEntry
                    choose={choose}
                    entry={entry}
                    key={entry.value}
                  />
                )}
              </Autocomplete.Collection>
            </Autocomplete.Group>
          )}
        </Autocomplete.List>
      </div>
    </Autocomplete.Root>
  );
}

function labelOf(
  item: PaletteItem,
  t: (id: MessageId, values?: Record<string, unknown>) => string
): string {
  switch (item.kind) {
    case "page":
      return t(item.item.label);
    case "action":
      return t(item.label);
    case "monitor":
      return item.monitor.name;
    default:
      // First-strong isolates, as a <bdi> would: a typed URL keeps its own order inside the Arabic sentence.
      return t("app_palette_search_monitors", {
        query: `\u2068${item.query}\u2069`,
      });
  }
}
