import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { createContext, type ReactNode, use } from "react";
import { cn } from "./cn.ts";

// A status reads as its coloured mark and the bare word, a label as plain
// text; only the default variant keeps a fill. `max-w-fit` rather than `w-fit`
// keeps a stretched badge to its content without undoing the 1 px width of one
// hidden with `sr-only`, which would push its word off screen.
const badgeVariants = cva(
  "group/badge inline-flex max-w-fit shrink-0 items-center gap-1.5 whitespace-nowrap font-medium text-xs transition-colors [&>svg:not([data-slot=badge-mark])]:size-icon-sm! [&>svg]:pointer-events-none",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "h-5 rounded-md bg-primary px-1.5 text-primary-foreground",
        degraded: "text-status-degraded-text",
        down: "text-status-down-text",
        maintenance: "text-status-maintenance-text",
        outline: "text-foreground",
        partial: "text-status-partial-text",
        paused: "text-status-paused-text",
        // A label that describes (a group, a tag) at normal weight, so the status beside it leads.
        secondary: "font-normal text-muted-foreground",
        up: "text-status-up-text",
      },
    },
  }
);

export type BadgeProps = useRender.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    /** Whether a status variant draws its mark; off where an icon beside it already names the level. */
    mark?: boolean;
  };

export type BadgeVariant = NonNullable<BadgeProps["variant"]>;

/**
 * The status variants whose colour the status page around a badge picked
 * itself. Such a badge's mark takes the colour and its word stays in ink, so
 * a page's colour never decides whether its text reads. Empty outside a
 * status page.
 */
export const PageStatusColours = createContext<ReadonlySet<BadgeVariant>>(
  new Set()
);

/** Each status variant's colour, the fill of its mark. */
const fills: Partial<Record<BadgeVariant, string>> = {
  degraded: "text-status-degraded",
  down: "text-status-down",
  maintenance: "text-status-maintenance",
  partial: "text-status-partial",
  paused: "text-status-paused",
  up: "text-status-up",
};

/** The glyph inside each status mark, so a level reads without its colour: a tick, a mark, a cross, a clock, two bars. */
export const glyphs: Partial<Record<BadgeVariant, string>> = {
  degraded: "M12 7.5v5.5M12 16.5v.01",
  down: "m9 9 6 6M15 9l-6 6",
  maintenance: "M12 7v5l3 2",
  partial: "M12 7.5v5.5M12 16.5v.01",
  paused: "M10 8.5v7M14 8.5v7",
  up: "m8 12.5 2.5 2.5 5.5-5.5",
};

/** A status as a filled disc carrying its glyph; decorative, the word sits beside it. */
function StatusMark({
  className,
  variant,
}: {
  readonly className?: string;
  readonly variant: BadgeVariant;
}): ReactNode {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", fills[variant], className)}
      data-slot="badge-mark"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" fill="currentColor" r="11" />
      <path
        d={glyphs[variant]}
        fill="none"
        stroke="var(--card)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.6"
      />
    </svg>
  );
}

function Badge({
  children,
  className,
  variant = "default",
  mark = true,
  render,
  ...props
}: BadgeProps) {
  const shown = variant ?? "default";
  const status = mark && shown in fills;
  // A colour the status page picked is the mark's alone; the word stays in ink so it always reads.
  const own = use(PageStatusColours).has(shown);
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        children: status ? (
          <>
            <StatusMark variant={shown} />
            {children}
          </>
        ) : (
          children
        ),
        className: cn(
          badgeVariants({ variant: shown }),
          own && "text-foreground",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "badge", variant },
  });
}

/** A status colour as a small dot beside the word that names it; a level without a colour is grey. */
function StatusDot({ variant }: { readonly variant: BadgeVariant }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full bg-current",
        fills[variant] ?? "text-muted-foreground/40"
      )}
      data-slot="status-dot"
    />
  );
}

export { Badge, badgeVariants, StatusDot, StatusMark };
