/**
 * A page's header row: on the start side the sidebar trigger,
 * the parent page's link on a page one level down, and the title; on the end
 * side the primary action; then the page's own content below. Global search
 * sits in the sidebar, so this row holds the page's controls alone.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CardFooter } from "@/shared/ui/card.tsx";
import { ChevronEndIcon } from "@/shared/ui/icons.tsx";
import { SidebarTrigger } from "@/shared/ui/sidebar.tsx";

/** The page one level up, linked before the title: a list, or the record a form edits. */
export interface PageParent {
  readonly label: string;
  readonly to: string;
}

/** A single-column form's width, every form the same. */
export const formWidth = "max-w-3xl";

/** The columns of a form with a side panel (a test, a URL, a summary): the panel's width, every form the same; one column below `lg` that never grows past the screen for a long URL. */
export const formWithPanel = "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_24rem]";

/** A form's last card's footer: the save's outcome on the start side, Cancel and Save on the end side, on every form. */
export function FormFooter({
  children,
  outcome,
}: {
  readonly children: ReactNode;
  readonly outcome?: ReactNode;
}): ReactNode {
  return (
    <CardFooter className="flex flex-wrap items-center justify-between gap-3">
      {outcome}
      <div className="ms-auto flex items-center gap-2">{children}</div>
    </CardFooter>
  );
}

/** The page's column: centred and capped on wide screens, one step wider on the widest; a pending page's skeleton shares it. */
export const pageColumn =
  "mx-auto flex w-full @min-[120rem]:max-w-[96rem] max-w-7xl flex-col gap-6 px-6 pt-1 pb-6";

/** The header row, pinned from tablet width up so a long page's actions stay in reach; a phone's wrapped row would cover too much. */
export const pageHeaderRow =
  "z-10 -mx-6 -mb-3 flex min-h-control flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-background/85 px-6 py-3 backdrop-blur-sm md:sticky md:top-0";

export interface PageProps {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly parent?: PageParent;
  readonly title: string;
}

export function Page({
  action,
  children,
  parent,
  title,
}: PageProps): ReactNode {
  return (
    <div className={pageColumn} data-slot="page">
      <div className={pageHeaderRow}>
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="-ms-2" />
          <span aria-hidden="true" className="me-1 h-4 w-px bg-border" />
          {parent ? (
            <>
              <Link
                className="max-w-48 shrink-0 truncate rounded-sm text-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring-soft"
                data-slot="page-parent"
                to={parent.to}
              >
                <bdi>{parent.label}</bdi>
              </Link>
              <ChevronEndIcon className="size-icon shrink-0 text-muted-foreground" />
            </>
          ) : null}
          <h1 className="min-w-0 truncate font-semibold text-lg">
            {/* A stored title may be in the other language: isolated, it keeps its own order. */}
            <bdi>{title}</bdi>
          </h1>
        </div>
        {action ? (
          <div className="flex flex-wrap items-center gap-2">{action}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
