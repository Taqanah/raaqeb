/**
 * What an admin page shows while its read takes longer than the router's
 * pending time: placeholders in the page's own shape, under
 * the page frame's title row, announced to assistive technology as loading.
 * A list page, a form and a settings page each have theirs here; the
 * monitors list and the monitor detail have their own in admin/monitors.
 * Each draws with the real page's cards, fields and table, so the read
 * landing changes the content and moves nothing.
 */
import type { ReactNode } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { Field } from "@/shared/ui/field.tsx";
import { SidebarTrigger } from "@/shared/ui/sidebar.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table.tsx";
import {
  FormFooter,
  formWidth,
  formWithPanel,
  pageColumn,
  pageHeaderRow,
} from "./page.tsx";

/** One placeholder, a grey block sized by its caller: a control, a badge, a mark, the chart. */
export function Bar({ className }: { readonly className?: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block shrink-0 rounded-md bg-subtle motion-safe:animate-skeleton",
        className
      )}
    />
  );
}

/** One line of text's placeholder: the line's own height with a shorter bar in it, so the text that replaces it moves nothing; the caller gives the width and the text size. */
export function TextBar({
  className,
}: {
  readonly className?: string;
}): ReactNode {
  return (
    <span className={cn("flex h-lh max-w-full items-center", className)}>
      <Bar className="h-[0.75em] w-full" />
    </span>
  );
}

/** A control's placeholder: a button or a field, 40 px high. */
export const controlBar = "h-control rounded-lg";

/** The rows a skeleton's table or list draws, each a key. */
export const skeletonRows = [1, 2, 3, 4, 5, 6] as const;

/** The placeholders' region, announced to assistive technology as loading. */
export function LoadingRegion({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className: string;
}): ReactNode {
  const { t } = useMessages();
  return (
    <div className={className} data-slot="page-skeleton" role="status">
      <span className="sr-only">{t("app_loading")}</span>
      {children}
    </div>
  );
}

/** The page frame while its read is pending: the title row with a placeholder for each of the page's action buttons, by width (none when the page has none), then the page's own placeholders. */
export function SkeletonPage({
  action = [],
  children,
  parent = false,
}: {
  readonly action?: readonly string[];
  readonly children: ReactNode;
  /** The page links its parent before the title (a record, a form), so the title row's text runs longer. */
  readonly parent?: boolean;
}): ReactNode {
  return (
    <div className={pageColumn}>
      <div className={pageHeaderRow}>
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="-ms-2" />
          <span aria-hidden="true" className="me-1 h-4 w-px bg-border" />
          {/* A list's short title is narrower on a phone, so its add button stays beside it; a parent and a title together push a page's buttons to their own row on a phone, as the page does. */}
          <TextBar
            className={cn("text-lg", parent ? "w-56" : "w-24 sm:w-40")}
          />
        </div>
        {action.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {action.map((width) => (
              <Bar className={cn(controlBar, width)} key={width} />
            ))}
          </div>
        ) : null}
      </div>
      <LoadingRegion className="flex flex-col gap-6">{children}</LoadingRegion>
    </div>
  );
}

/** A table's head and rows, one line a cell; `cells` are the cells' widths, one a column. */
export function TableSkeleton({
  cells,
  framed = false,
}: {
  readonly cells: readonly string[];
  readonly framed?: boolean;
}): ReactNode {
  return (
    <Table framed={framed} stacked>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {cells.map((width) => (
            <TableHead key={width}>
              <TextBar className="w-12 text-xs" />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {skeletonRows.map((row) => (
          <TableRow className="hover:bg-transparent" key={row}>
            {cells.map((width) => (
              <TableCell key={width}>
                <TextBar className={width} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The add button every list page but the subscribers' has. */
const addAction = ["w-32"] as const;

/** A list's cells' widths, the first `columns` of them drawn. */
const listCells = ["w-40", "w-20", "w-28", "w-16", "w-24", "w-14", "w-12"];

/** A list page: its action, the add button unless told otherwise, and a framed table of its columns, five unless told otherwise. */
export function PageSkeleton({
  action = addAction,
  columns = 5,
}: {
  readonly action?: readonly string[];
  readonly columns?: number;
}): ReactNode {
  return (
    <SkeletonPage action={action}>
      <TableSkeleton cells={listCells.slice(0, columns)} framed />
    </SkeletonPage>
  );
}

/** A form's card: its divided header, a field a label width, and the save's footer on the last card. */
function FormCardSkeleton({
  children,
  fields,
  footer = false,
  header = true,
}: {
  readonly children?: ReactNode;
  readonly fields: readonly string[];
  readonly footer?: boolean;
  readonly header?: boolean;
}): ReactNode {
  return (
    <Card>
      {header ? (
        <CardHeader divided>
          <CardTitle>
            <TextBar className="w-32" />
          </CardTitle>
          <CardDescription>
            <TextBar className="w-64" />
          </CardDescription>
        </CardHeader>
      ) : null}
      <CardContent className="flex flex-col gap-5">
        {fields.map((width) => (
          <Field key={width}>
            {/* A field stretches its children, so the label's line sits in its own. */}
            <span>
              <TextBar className={cn("text-sm leading-snug", width)} />
            </span>
            <Bar className={controlBar} />
          </Field>
        ))}
        {children}
      </CardContent>
      {footer ? (
        <FormFooter>
          <Bar className={cn(controlBar, "w-20")} />
          <Bar className={cn(controlBar, "w-20")} />
        </FormFooter>
      ) : null}
    </Card>
  );
}

/** A form page: its action's buttons when it has any (the page editor's), its cards at the form width, beside a panel when the form has one, or in the panel's grid with no panel yet. */
export function FormSkeleton({
  action,
  panel,
}: {
  readonly action?: readonly string[];
  readonly panel?: "card" | "empty";
}): ReactNode {
  return (
    <SkeletonPage action={action} parent>
      <div
        className={cn(
          "grid items-start gap-6",
          panel ? formWithPanel : formWidth
        )}
      >
        <div className="flex min-w-0 flex-col gap-6">
          <FormCardSkeleton fields={["w-24", "w-32", "w-20"]} />
          <FormCardSkeleton fields={["w-28", "w-16"]} footer />
        </div>
        {/* The panel: a test's button, a URL, a summary. */}
        {panel === "card" ? (
          <FormCardSkeleton fields={[]}>
            <Bar className={cn(controlBar, "w-28")} />
          </FormCardSkeleton>
        ) : null}
      </div>
    </SkeletonPage>
  );
}

/** A settings page, whose frame already shows the title and the settings row: one form card at the form width, with a header on the pages whose cards have one. */
export function CardsSkeleton({
  header = false,
}: {
  readonly header?: boolean;
}): ReactNode {
  return (
    <LoadingRegion className={cn("flex flex-col gap-6", formWidth)}>
      <FormCardSkeleton
        fields={["w-24", "w-32", "w-20", "w-28"]}
        footer
        header={header}
      />
    </LoadingRegion>
  );
}
