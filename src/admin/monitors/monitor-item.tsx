/**
 * One monitor in the list, a row of its table. The name links to the detail page, the target is a token,
 * the group and the tags are secondary badges, and the state badge says
 * paused, up, degraded or down, or waits for the first check or heartbeat, beside
 * "under maintenance" while a window covers the monitor. The
 * per-item menu edits, duplicates, pauses or resumes, acknowledges an open
 * outage nobody acknowledged, and deletes.
 */
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback } from "react";
import { useOperatorCalendar } from "@/admin/shell/calendar.tsx";
import { ContentText } from "@/admin/shell/content.tsx";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { CheckResult } from "@/shared/schemas/check.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import type { OverviewDay, OverviewNotice } from "@/shared/schemas/overview.ts";
import { Badge } from "@/shared/ui/badge.tsx";
import { Button } from "@/shared/ui/button.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu.tsx";
import {
  BellOffIcon,
  CopyIcon,
  EllipsisIcon,
  FolderIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  TrashIcon,
} from "@/shared/ui/icons.tsx";
import { TableCell, TableRow } from "@/shared/ui/table.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { type NoticeKind, UptimeBar } from "@/shared/ui/uptime-bar.tsx";
import { checkTypeLabels, resultWords } from "./check-parts.tsx";

export interface MonitorItemProps {
  /** When its open outage nobody acknowledged started, so the menu offers to acknowledge that outage; none without one. */
  readonly acknowledgeable: number | undefined;
  /** A maintenance window in progress covers it, so it notifies nothing. */
  readonly covered: boolean;
  /** Its last 14 UTC days for the table's bar; none when they could not be read. */
  readonly days: readonly OverviewDay[] | undefined;
  /** A heartbeat monitor with no check yet has heard a heartbeat: its first window is open. */
  readonly heard: boolean;
  readonly monitor: Monitor;
  readonly onAcknowledge: (id: string, startedAt: number) => void;
  readonly onDelete: (id: string) => void;
  readonly onSelect: (id: string, selected: boolean) => void;
  readonly onTogglePaused: (monitor: Monitor) => void;
  readonly selected: boolean;
  /** The latest check's result, or nothing before the first check. */
  readonly state: CheckResult | undefined;
}

/** The item's own handlers over the list's stable ones. */
function useItem({
  acknowledgeable,
  monitor,
  onAcknowledge,
  onDelete,
  onSelect,
  onTogglePaused,
}: MonitorItemProps) {
  return {
    acknowledge: useCallback(() => {
      if (acknowledgeable !== undefined) {
        onAcknowledge(monitor.id, acknowledgeable);
      }
    }, [acknowledgeable, monitor.id, onAcknowledge]),
    remove: useCallback(() => onDelete(monitor.id), [monitor.id, onDelete]),
    select: useCallback(
      (checked: boolean) => onSelect(monitor.id, checked),
      [monitor.id, onSelect]
    ),
    togglePaused: useCallback(
      () => onTogglePaused(monitor),
      [monitor, onTogglePaused]
    ),
  };
}

/** The table's caps on a monitor's name and target by the space beside the sidebar: 12rem and 10rem, then 14 and 11 from 64rem, 18 and 14 from 72rem, 24 and 18 from 96rem, never wider than the cell; on a phone the cell may shrink to its column so the name ends in an ellipsis. */
const nameCaps =
  "[&_[data-slot=monitor-name]]:max-w-[min(100%,12rem)] [&_[data-slot=token]]:max-w-[min(100%,10rem)] @5xl:[&_[data-slot=monitor-name]]:max-w-[min(100%,14rem)] @5xl:[&_[data-slot=token]]:max-w-[min(100%,11rem)] @6xl:[&_[data-slot=monitor-name]]:max-w-[min(100%,18rem)] @6xl:[&_[data-slot=token]]:max-w-[min(100%,14rem)] @min-[96rem]:[&_[data-slot=monitor-name]]:max-w-[min(100%,24rem)] @min-[96rem]:[&_[data-slot=token]]:max-w-[min(100%,18rem)] max-sm:min-w-0 max-sm:[&_[data-slot=monitor-name]]:max-w-full";

/** The list's table on a phone, where a row is one line, the checkbox, the name, the state and the menu, the target left to a tablet and up. The name keeps at least 5rem. */
export const phoneRows =
  "max-sm:[&_tr]:grid max-sm:[&_tr]:grid-cols-[auto_minmax(5rem,1fr)_auto_auto]";

/** The state's badges wrap their words under 56rem beside the sidebar, a phone included, rather than squeeze the name. */
export const phoneState =
  "@max-4xl:[&_[data-slot^=monitor-]]:h-auto @max-4xl:[&_[data-slot^=monitor-]]:min-h-5 @max-4xl:[&_[data-slot^=monitor-]]:shrink @max-4xl:[&_[data-slot^=monitor-]]:whitespace-normal @max-4xl:[&_[data-slot^=monitor-]]:text-center";

export function MonitorTableRow(props: MonitorItemProps): ReactNode {
  const { covered, days, heard, monitor, selected, state } = props;
  const { t } = useMessages();
  const { acknowledge, remove, select, togglePaused } = useItem(props);
  return (
    <TableRow
      data-monitor={monitor.id}
      data-state={selected ? "selected" : undefined}
    >
      <TableCell>
        <Checkbox
          aria-label={t("monitor_select_one", { name: monitor.name })}
          checked={selected}
          onCheckedChange={select}
        />
      </TableCell>
      {/* A long name and a long target end in an ellipsis, the name allowed a little more, both wider on a wider screen, so the bar and the tags keep their room. The name's column takes the row's spare width, so the state and its bar sit together before the tags; from xl it takes no more, so a target as long as its cap ends in an ellipsis rather than push the table past its frame. */}
      <TableCell className={`w-full sm:max-w-0 ${nameCaps}`}>
        <Name monitor={monitor} />
      </TableCell>
      {/* The state now in its own column, so every bar lines up whatever the badge says; room after it, so the state, its bar and the tags read apart. */}
      <TableCell className={`@4xl:pe-14 ${phoneState}`}>
        <Status
          covered={covered}
          heard={heard}
          monitor={monitor}
          state={state}
        />
      </TableCell>
      {/* The last 14 days, right after the state badge. */}
      <TableCell className="ps-0 @4xl:pe-20 max-sm:hidden">
        {days ? <MonitorBar days={days} /> : null}
      </TableCell>
      {/* One line, capped so a long group or tag ends in an ellipsis rather than push the menu off the list: from 68rem the tags fit beside the caps; narrower, the type and the group, and under 40rem the type alone, the toolbar still filtering by group and tag. */}
      <TableCell className="max-sm:hidden @min-[68rem]:[&>div]:max-w-80 [&>div]:max-w-30 [&>div]:flex-nowrap @max-[40rem]:[&_[data-slot=monitor-group]]:hidden @max-[68rem]:[&_[data-slot=monitor-tag]]:hidden">
        <Organization monitor={monitor} />
      </TableCell>
      <TableCell className="w-10">
        <ItemMenu
          monitor={monitor}
          onAcknowledge={
            props.acknowledgeable === undefined ? undefined : acknowledge
          }
          onDelete={remove}
          onTogglePaused={togglePaused}
        />
      </TableCell>
    </TableRow>
  );
}

function Name({ monitor }: { readonly monitor: Monitor }): ReactNode {
  return (
    // The name leads on its own line and the target follows under it, so a long URL never cuts the name.
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      {/* The ellipsis clips at the padding box, and the underline sits 4 px under the text, so the padding gives it room and the margin takes the room back. */}
      <Link
        className="-mb-[0.25rem] min-w-0 max-w-full self-start truncate pb-[0.25rem] font-medium underline-offset-4 hover:underline"
        data-slot="monitor-name"
        // In the name's own direction the ellipsis falls at its end; `auto` skips the text of a bdi, so there is none inside.
        dir="auto"
        params={{ id: monitor.id }}
        to="/admin/monitors/$id"
      >
        {monitor.name}
      </Link>
      {monitor.target ? (
        <Token className="min-w-0 max-w-full self-start truncate bg-transparent px-0 text-muted-foreground text-xs max-sm:hidden">
          {monitor.target}
        </Token>
      ) : null}
    </div>
  );
}

function Organization({ monitor }: { readonly monitor: Monitor }): ReactNode {
  const { t } = useMessages();
  return (
    <div className="hidden shrink-0 flex-wrap items-center gap-x-3 gap-y-1 sm:flex">
      <Badge variant="outline">{t(checkTypeLabels[monitor.config.type])}</Badge>
      {monitor.group ? (
        <Badge
          className="min-w-0 shrink [&>svg]:shrink-0"
          data-slot="monitor-group"
          variant="secondary"
        >
          <FolderIcon />
          <span className="truncate" dir="auto">
            {monitor.group}
          </span>
        </Badge>
      ) : null}
      {monitor.tags.map((tag) => (
        <Badge
          className="min-w-0 shrink"
          data-slot="monitor-tag"
          key={tag}
          variant="secondary"
        >
          <span className="truncate" dir="auto">
            {tag}
          </span>
        </Badge>
      ))}
    </div>
  );
}

function Status({
  covered,
  heard,
  monitor,
  state,
}: {
  readonly covered: boolean;
  readonly heard: boolean;
  readonly monitor: Monitor;
  readonly state: CheckResult | undefined;
}): ReactNode {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <StateBadge heard={heard} monitor={monitor} state={state} />
      {covered && !monitor.paused ? <MaintenanceBadge /> : null}
    </span>
  );
}

/** The monitor's last 14 days, compact and with no caption, as wide as the row allows from 9rem up to slim days 8px wide; under 56rem beside the sidebar the badge stands alone. */
function MonitorBar({
  days,
}: {
  readonly days: readonly OverviewDay[];
}): ReactNode {
  const calendar = useOperatorCalendar();
  return (
    <div className="@max-4xl:hidden min-w-36" data-slot="monitor-bar">
      <UptimeBar
        calendar={calendar}
        caption={false}
        // A day stops at 8px wide, so a wide row keeps the bar's days slim rather than square.
        className="justify-center [&>button]:h-8 [&>button]:max-w-2"
        days={days}
        notice={windowNotice}
        percentages={false}
      />
    </div>
  );
}

/** A notice in a monitor's day card: a monitor's day names only the windows that covered it, each opening its admin page. */
export function windowNotice(
  _kind: NoticeKind,
  each: OverviewNotice
): ReactNode {
  return (
    <Link
      className="underline-offset-4 hover:underline"
      params={{ id: each.id }}
      to="/admin/maintenance/$id"
    >
      <ContentText content={each.title} />
    </Link>
  );
}

/** The monitor's state, in the list and on its detail: paused wins over the latest check's result; a monitor with no check yet waits for its first check or heartbeat. */
export function StateBadge({
  heard,
  monitor,
  state,
}: {
  /** A heartbeat arrived before the first check: its window is open, so the badge must not say none came. */
  readonly heard: boolean;
  readonly monitor: Monitor;
  readonly state: CheckResult | undefined;
}): ReactNode {
  const { t } = useMessages();
  if (monitor.paused) {
    return (
      <Badge data-slot="monitor-paused" variant="paused">
        {t("monitor_paused")}
      </Badge>
    );
  }
  if (state) {
    return (
      <Badge data-slot="monitor-state" data-state={state} variant={state}>
        {t(resultWords[state])}
      </Badge>
    );
  }
  // The quietest badge: the grey word alone, no mark, the colour of no data. Once a heartbeat is heard, the monitor waits for its window to close, which is its first check.
  return (
    <Badge data-slot="monitor-waiting" variant="secondary">
      {t(
        monitor.config.type === "heartbeat" && !heard
          ? "monitor_waiting_first_heartbeat"
          : "monitor_waiting_first_check"
      )}
    </Badge>
  );
}

/** A maintenance window in progress covers the monitor: its checks run, it notifies nothing, and its time is not observed. */
export function MaintenanceBadge(): ReactNode {
  const { t } = useMessages();
  return (
    <Badge data-slot="monitor-maintenance" variant="maintenance">
      {t("monitor_under_maintenance")}
    </Badge>
  );
}

function ItemMenu({
  monitor,
  onAcknowledge,
  onDelete,
  onTogglePaused,
}: {
  readonly monitor: Monitor;
  /** Present only while the monitor has an open outage nobody acknowledged. */
  readonly onAcknowledge: (() => void) | undefined;
  readonly onDelete: () => void;
  readonly onTogglePaused: () => void;
}): ReactNode {
  const { t } = useMessages();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t("monitor_actions")}
            className="text-muted-foreground"
            data-slot="monitor-menu"
            size="icon"
            variant="ghost"
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          render={
            <Link params={{ id: monitor.id }} to="/admin/monitors/$id/edit" />
          }
        >
          <PencilIcon />
          {t("monitor_edit")}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-action="duplicate"
          render={
            <Link search={{ copy: monitor.id }} to="/admin/monitors/new" />
          }
        >
          <CopyIcon />
          {t("monitor_duplicate")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onTogglePaused}>
          {monitor.paused ? <PlayIcon /> : <PauseIcon />}
          {monitor.paused ? t("monitor_resume") : t("monitor_pause")}
        </DropdownMenuItem>
        {onAcknowledge ? (
          <DropdownMenuItem data-action="acknowledge" onClick={onAcknowledge}>
            <BellOffIcon />
            {t("monitor_acknowledge")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDelete} variant="destructive">
          <TrashIcon />
          {t("app_delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
