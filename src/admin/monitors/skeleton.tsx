/**
 * The monitors list's and the monitor detail's pending placeholders,
 * each in its page's shape so nothing moves when the read lands.
 */
import type { ReactNode } from "react";
import {
  Bar,
  controlBar,
  SkeletonPage,
  skeletonRows,
  TableSkeleton,
  TextBar,
} from "@/admin/shell/page-skeleton.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table.tsx";
import { phoneRows, phoneState } from "./monitor-item.tsx";

/** A checkbox's placeholder. */
const mark = "size-mark rounded-sm";

/** A group of buttons in a 2 px inset, as the range switch draws. */
const inset = "box-content p-0.5";

/** The detail's action buttons by width. */
const detailActions = [
  "w-28 max-sm:w-control",
  "w-24 max-sm:w-control",
  "w-26 max-sm:w-control",
  "w-20",
] as const;

/** The list's add button with its N chip. */
const listAction = ["w-36"] as const;

/** The list: the toolbar, then the table. */
export function MonitorListSkeleton(): ReactNode {
  return (
    <SkeletonPage action={listAction}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Bar className={cn(controlBar, "min-w-48 flex-1")} />
          <Bar className={cn(controlBar, "w-32")} />
          <Bar className={cn(controlBar, "w-28")} />
          <Bar className={cn(controlBar, "w-48")} />
        </div>
        {/* The select-all line a phone has above its table. */}
        <div className="flex h-4 items-center gap-3 px-3 sm:hidden">
          <Bar className={mark} />
          <TextBar className="w-16 text-xs" />
        </div>
        <TableRows />
      </div>
    </SkeletonPage>
  );
}

/** A monitor's name over its target. */
function NameLines(): ReactNode {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <TextBar className="w-40" />
      {/* The target is a token, a pixel of padding above and below its line. */}
      <TextBar className="box-content w-28 py-px text-xs max-sm:hidden" />
    </span>
  );
}

/** The check type and a group, from a tablet's width up. */
function OrganizationBadges(): ReactNode {
  return (
    <span className="hidden shrink-0 items-center gap-1 sm:flex">
      <Bar className="h-5 w-12" />
      <Bar className="h-5 w-16" />
    </span>
  );
}

function TableRows(): ReactNode {
  return (
    <Table className={phoneRows} framed stacked>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pe-0">
            <Bar className={mark} />
          </TableHead>
          <TableHead>
            <TextBar className="w-12 text-xs" />
          </TableHead>
          <TableHead colSpan={2}>
            <TextBar className="w-12 text-xs" />
          </TableHead>
          <TableHead>
            <TextBar className="w-16 text-xs" />
          </TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {skeletonRows.map((row) => (
          <TableRow className="hover:bg-transparent" key={row}>
            <TableCell className="pe-0">
              <Bar className={mark} />
            </TableCell>
            <TableCell className="w-full">
              <NameLines />
            </TableCell>
            <TableCell className={`@4xl:pe-14 ${phoneState}`}>
              <Bar className="h-5 w-14" />
            </TableCell>
            {/* The last 14 days at 8 px a day, after the state, as the row's bar is; a screen under lg has none. */}
            <TableCell className="ps-0 @4xl:pe-20 max-sm:hidden">
              <Bar className="@max-4xl:hidden h-8 w-34 rounded-none" />
            </TableCell>
            <TableCell className="max-sm:hidden">
              <OrganizationBadges />
            </TableCell>
            {/* The item menu's button. */}
            <TableCell className="w-10">
              <span className="block size-control" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The four uptime windows' tiles. */
const windows = ["24h", "7d", "30d", "90d"] as const;

/** The detail: the summary, the uptime tiles, the day bar, the chart and the recent checks. */
export function MonitorDetailSkeleton(): ReactNode {
  return (
    <SkeletonPage
      // Check now, pause and duplicate, icons on a phone and labelled wider, then edit.
      action={detailActions}
      parent
    >
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <Bar className="h-5 w-14" />
          <TextBar className="w-48" />
          <Bar className="h-5 w-12" />
          <TextBar className="w-20" />
          <TextBar className="ms-auto w-28" />
        </CardContent>
      </Card>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {windows.map((window) => (
          <Card key={window}>
            <CardContent className="flex flex-col gap-1">
              <TextBar className="w-20 text-xs" />
              <TextBar className="w-24 text-2xl" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <TextBar className="w-36" />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5">
          <Bar className="h-8 rounded-none" />
          <div className="flex justify-between gap-2 text-xs">
            <TextBar className="w-16" />
            <TextBar className="w-10" />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>
            <TextBar className="w-28" />
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {/* The range switch, four 40 px buttons in a 2 px inset, and the history download. */}
            <Bar className={cn(controlBar, inset, "w-64")} />
            <Bar className={cn(controlBar, "w-36")} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TextBar className="w-72 text-sm" />
          <div className="flex gap-3">
            {/* The axis's labels' room. */}
            <span className="w-10 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Bar className="h-48" />
              <span className="h-4" />
            </div>
          </div>
          <TextBar className="w-56 text-xs" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <TextBar className="w-28" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TableSkeleton cells={["w-28", "w-12", "w-24", "w-14", "w-6"]} />
        </CardContent>
      </Card>
    </SkeletonPage>
  );
}
