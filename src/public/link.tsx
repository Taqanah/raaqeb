/**
 * Links between the views of one status page: a client
 * navigation, so each one is a fetch of the view's document through the
 * memo; the language switch is the one plain link, a full load.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type PublicView, viewPath } from "@/shared/schemas/overview.ts";

/** A link to another view of the same page: a client navigation, one document fetch through the memo. */
export function ViewLink({
  children,
  className,
  reload = false,
  slot,
  suffix,
  view,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  /** A full document load rather than a client navigation: from a not-found, whose root knows no page. */
  readonly reload?: boolean;
  readonly slot?: string;
  readonly suffix: string;
  readonly view: PublicView;
}): ReactNode {
  const to: string = viewPath(view.paths, view.locale, suffix);
  return (
    <Link
      className={className}
      data-slot={slot}
      // No read on hover: a visitor's hover would cost the server a request whether or not a click follows.
      preload={false}
      reloadDocument={reload}
      to={to}
    >
      {children}
    </Link>
  );
}

/** A text link in the page's quiet style, tinted by its brand colour on hover. */
export const quietLink =
  "rounded-sm underline-offset-4 hover:text-[var(--brand,var(--foreground))] hover:underline";
