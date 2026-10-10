import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

/** On a phone a stacked table drops its header and wraps each row's cells under its first, the name, so no column hides past the edge. */
const stackedOnPhone =
  "max-sm:block max-sm:[&_tbody]:block max-sm:[&_thead]:hidden max-sm:[&_tr]:flex max-sm:[&_tr]:flex-wrap max-sm:[&_tr]:items-center max-sm:[&_tr]:gap-x-3 max-sm:[&_tr]:gap-y-1.5 max-sm:[&_tr]:p-3 max-sm:[&_td]:p-0 max-sm:[&_td:empty]:hidden max-sm:[&_td:first-child]:basis-full max-sm:[&_td:first-child]:whitespace-normal";

/** `framed` draws a list page's table in its own bordered card; a table already inside a card leaves it off. `stacked` lays a list's rows out for a phone. */
function Table({
  className,
  framed = false,
  stacked = false,
  ...props
}: ComponentProps<"table"> & {
  readonly framed?: boolean;
  readonly stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative w-full overflow-x-auto",
        framed && "rounded-xl bg-card ring-line"
      )}
      data-slot="table-container"
    >
      <table
        className={cn("w-full text-sm", stacked && stackedOnPhone, className)}
        data-slot="table"
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return (
    <thead
      className={cn("[&_tr]:border-b", className)}
      data-slot="table-header"
      {...props}
    />
  );
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return (
    <tbody
      className={cn("[&_tr:last-child]:border-0", className)}
      data-slot="table-body"
      {...props}
    />
  );
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "relative border-b transition-colors hover:bg-muted has-aria-expanded:bg-muted data-[state=selected]:bg-subtle",
        className
      )}
      data-slot="table-row"
      {...props}
    />
  );
}

function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-control whitespace-nowrap px-3 text-start align-middle font-medium text-muted-foreground text-xs [&:has([role=checkbox])]:pe-0",
        className
      )}
      data-slot="table-head"
      {...props}
    />
  );
}

function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-3 py-2.5 align-middle [&:has([role=checkbox])]:pe-0",
        className
      )}
      data-slot="table-cell"
      {...props}
    />
  );
}

/** A row's one link, stretched over the whole row so a click anywhere in it opens the record. */
const tableRowLink =
  "font-medium underline-offset-4 after:absolute after:inset-0 hover:underline";

export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  tableRowLink,
};
