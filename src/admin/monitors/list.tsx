/**
 * The monitors list: the toolbar, the table, the selection bar with bulk pause, resume and delete and the change of a
 * channel, the group or a tag, and the no-matches
 * state. The loader answers every monitor once; the search parameters and
 * the locale arrange them here, so typing never re-reads the database.
 */
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { arrangeMonitors, filterOptions } from "@/shared/domain/monitors.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { ChannelChoice } from "@/shared/schemas/channel.ts";
import type {
  Monitor,
  MonitorBulkResult,
  MonitorChange,
  MonitorListSearch,
  MonitorStates,
} from "@/shared/schemas/monitor.ts";
import type { OverviewDay } from "@/shared/schemas/overview.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog.tsx";
import { Button } from "@/shared/ui/button.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/shared/ui/empty.tsx";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table.tsx";
import { BulkChange } from "./bulk-change.tsx";
import {
  type MonitorItemProps,
  MonitorTableRow,
  phoneRows,
} from "./monitor-item.tsx";
import { Toolbar } from "./toolbar.tsx";

export type BulkCall = (ids: readonly string[]) => Promise<MonitorBulkResult>;

export interface MonitorListProps {
  /** The monitors with an open outage nobody acknowledged, each with when that outage started. */
  readonly acknowledgeable: Readonly<Record<string, number>>;
  readonly actions: {
    readonly acknowledge: (
      id: string,
      startedAt: number
    ) => Promise<{ readonly ok: boolean }>;
    readonly change: (
      ids: readonly string[],
      change: MonitorChange
    ) => Promise<MonitorBulkResult>;
    readonly delete: BulkCall;
    readonly pause: BulkCall;
    readonly resume: BulkCall;
  };
  /** Every channel, for the selection bar's channel changes. */
  readonly channels: readonly ChannelChoice[];
  /** The monitors a maintenance window in progress covers now. */
  readonly covered: readonly string[];
  /** Each monitor's last 14 UTC days, by id, for the table's bar. */
  readonly days: Readonly<Record<string, readonly OverviewDay[]>>;
  /** The heartbeat monitors with no check yet that have heard a heartbeat. */
  readonly heard: readonly string[];
  readonly monitors: readonly Monitor[];
  readonly onSearch: (next: MonitorListSearch) => void;
  readonly search: MonitorListSearch;
  readonly states: MonitorStates;
}

const noSearch: MonitorListSearch = {};

interface PendingDelete {
  readonly ids: readonly string[];
  /** Set when the delete came from one item's menu, so the dialog names it. */
  readonly name?: string;
}
const noSelection: ReadonlySet<string> = new Set();

export function MonitorList({
  acknowledgeable,
  actions,
  channels,
  covered,
  days,
  heard,
  monitors,
  onSearch,
  search,
  states,
}: MonitorListProps): ReactNode {
  const { locale, t } = useMessages();
  const [selected, setSelected] = useState(noSelection);
  const [pendingDelete, setPendingDelete] = useState<
    PendingDelete | undefined
  >();
  const [failed, setFailed] = useState(false);
  const shown = useMemo(
    () => arrangeMonitors(monitors, search, locale),
    [locale, monitors, search]
  );
  const options = useMemo(
    () => filterOptions(monitors, locale),
    [locale, monitors]
  );
  // A monitor deleted or filtered away leaves the selection.
  const selectedMonitors = useMemo(
    () => shown.filter((monitor) => selected.has(monitor.id)),
    [selected, shown]
  );
  const selectedIds = useMemo(
    () => selectedMonitors.map((monitor) => monitor.id),
    [selectedMonitors]
  );

  const select = useCallback((id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);
  const selectAll = useCallback(
    (on: boolean) => {
      setSelected(
        on ? new Set(shown.map((monitor) => monitor.id)) : noSelection
      );
    },
    [shown]
  );
  // A rejected call (the server unreachable, or a refusal thrown before the handler) reads as unavailable; the page never throws into the router.
  const run = useCallback(async (call: BulkCall, ids: readonly string[]) => {
    const result = await call(ids).catch(() => ({ ok: false as const }));
    setFailed(!result.ok);
    if (result.ok) {
      setSelected(noSelection);
    }
  }, []);
  const togglePaused = useCallback(
    (monitor: Monitor) =>
      run(monitor.paused ? actions.resume : actions.pause, [monitor.id]),
    [actions.pause, actions.resume, run]
  );
  const acknowledge = useCallback(
    async (id: string, startedAt: number) => {
      const result = await actions
        .acknowledge(id, startedAt)
        .catch(() => ({ ok: false }));
      setFailed(!result.ok);
    },
    [actions]
  );
  const askDelete = useCallback(
    (id: string) =>
      setPendingDelete({
        ids: [id],
        name: monitors.find((monitor) => monitor.id === id)?.name,
      }),
    [monitors]
  );
  const pauseSelected = useCallback(
    () => run(actions.pause, selectedIds),
    [actions.pause, run, selectedIds]
  );
  const resumeSelected = useCallback(
    () => run(actions.resume, selectedIds),
    [actions.resume, run, selectedIds]
  );
  // The dialog words a refusal itself; a change made clears the selection as the other actions do.
  const changeSelected = useCallback(
    async (change: MonitorChange) => {
      const result = await actions.change(selectedIds, change);
      if (result.ok) {
        setFailed(false);
        setSelected(noSelection);
      }
      return result;
    },
    [actions, selectedIds]
  );
  // One monitor selected is asked about by name, as from its own menu.
  const askDeleteSelected = useCallback(
    () =>
      setPendingDelete({
        ids: selectedIds,
        name:
          selectedMonitors.length === 1 ? selectedMonitors[0]?.name : undefined,
      }),
    [selectedIds, selectedMonitors]
  );
  const closeDelete = useCallback((open: boolean) => {
    if (!open) {
      setPendingDelete(undefined);
    }
  }, []);
  const confirmDelete = useCallback(async () => {
    if (pendingDelete) {
      await run(actions.delete, pendingDelete.ids);
      setPendingDelete(undefined);
    }
  }, [actions.delete, pendingDelete, run]);
  const clearFilters = useCallback(() => onSearch(noSearch), [onSearch]);

  const allShownSelected =
    shown.length > 0 && selectedIds.length === shown.length;
  const someShownSelected = selectedIds.length > 0 && !allShownSelected;
  const itemProps = (monitor: Monitor): MonitorItemProps => ({
    acknowledgeable: acknowledgeable[monitor.id],
    days: days[monitor.id],
    covered: covered.includes(monitor.id),
    heard: heard.includes(monitor.id),
    monitor,
    onAcknowledge: acknowledge,
    onDelete: askDelete,
    onSelect: select,
    onTogglePaused: togglePaused,
    selected: selected.has(monitor.id),
    state: states[monitor.id],
  });

  let body: ReactNode;
  if (shown.length === 0) {
    body = (
      <Empty data-slot="monitor-no-matches">
        <EmptyHeader>
          <EmptyTitle>{t("monitor_no_matches")}</EmptyTitle>
          <EmptyDescription>{t("monitor_no_matches_hint")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={clearFilters} variant="outline">
            {t("monitor_clear_filters")}
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    body = (
      <>
        {/* A stacked table has no header on a phone, so select-all sits above it. */}
        <div className="flex items-center gap-3 px-3 text-muted-foreground text-xs sm:hidden">
          <SelectAll
            checked={allShownSelected}
            mixed={someShownSelected}
            onChange={selectAll}
            slot="monitor-select-all-phone"
          />
          <span aria-hidden="true">{t("monitor_select_all")}</span>
        </div>
        <Table className={phoneRows} framed stacked>
          <TableHeader>
            <TableRow>
              <TableHead>
                <SelectAll
                  checked={allShownSelected}
                  mixed={someShownSelected}
                  onChange={selectAll}
                />
              </TableHead>
              <TableHead>{t("monitor_column_name")}</TableHead>
              {/* Over the state's badge and its bar, two columns. */}
              <TableHead colSpan={2}>{t("monitor_column_state")}</TableHead>
              <TableHead>{t("monitor_column_organization")}</TableHead>
              {/* The item menus' column, named for a screen reader only. */}
              <TableHead>
                <span className="sr-only">{t("monitor_actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((monitor) => (
              <MonitorTableRow key={monitor.id} {...itemProps(monitor)} />
            ))}
          </TableBody>
        </Table>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-slot="monitor-list">
      <Toolbar
        groups={options.groups}
        onSearch={onSearch}
        search={search}
        tags={options.tags}
      />
      {failed ? (
        <Alert variant="destructive">
          <AlertDescription>{t("monitor_unavailable")}</AlertDescription>
        </Alert>
      ) : null}
      {selectedIds.length > 0 ? (
        <div
          className="flex min-h-control flex-wrap items-center gap-2 rounded-lg bg-subtle px-3 py-1 text-sm"
          data-slot="monitor-bulk"
        >
          <span>{t("monitor_selected", { count: selectedIds.length })}</span>
          <Button
            className="ms-auto"
            data-action="pause"
            onClick={pauseSelected}
            size="sm"
            variant="outline"
          >
            {t("monitor_pause")}
          </Button>
          <Button
            data-action="resume"
            onClick={resumeSelected}
            size="sm"
            variant="outline"
          >
            {t("monitor_resume")}
          </Button>
          <BulkChange
            channels={channels}
            groups={options.groups}
            onChange={changeSelected}
            selected={selectedMonitors}
            tags={options.tags}
          />
          <Button
            data-action="delete"
            onClick={askDeleteSelected}
            size="sm"
            variant="destructive"
          >
            {t("app_delete")}
          </Button>
        </div>
      ) : null}
      {body}
      <AlertDialog
        onOpenChange={closeDelete}
        open={pendingDelete !== undefined}
      >
        <AlertDialogContent data-slot="monitor-delete-dialog">
          <AlertDialogHeader>
            {pendingDelete?.name === undefined ? (
              <>
                <AlertDialogTitle>{t("monitor_delete_title")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("monitor_delete_description", {
                    count: pendingDelete?.ids.length ?? 0,
                  })}
                </AlertDialogDescription>
              </>
            ) : (
              <>
                <AlertDialogTitle>
                  {t("monitor_delete_one_title")}
                </AlertDialogTitle>
                {/* The name on its own line, as the subscriber's address is, so it never runs into the question. */}
                <p className="font-medium" data-slot="monitor-delete-name">
                  <bdi>{pendingDelete.name}</bdi>
                </p>
                <AlertDialogDescription>
                  {t("monitor_delete_one_description")}
                </AlertDialogDescription>
              </>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("app_cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-slot="monitor-delete-confirm"
              onClick={confirmDelete}
              variant="destructive"
            >
              {t("app_delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SelectAll({
  checked,
  mixed,
  onChange,
  slot = "monitor-select-all",
}: {
  readonly checked: boolean;
  /** Some of the shown monitors are selected, not all. */
  readonly mixed: boolean;
  readonly onChange: (on: boolean) => void;
  /** The phone line carries its own slot, so one selector still names one checkbox. */
  readonly slot?: string;
}): ReactNode {
  const { t } = useMessages();
  const onCheckedChange = useCallback(
    (on: boolean) => onChange(on),
    [onChange]
  );
  return (
    <Checkbox
      aria-label={t("monitor_select_all")}
      checked={checked}
      data-slot={slot}
      indeterminate={mixed}
      onCheckedChange={onCheckedChange}
    />
  );
}
