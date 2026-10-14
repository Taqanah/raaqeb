/**
 * The option card: a choice drawn as a card, for
 * choices that are a look to see (a theme, a font size) or that carry a
 * consequence worth a line (the database, the export). Underneath it is a
 * radio group, as the segmented control is; the chosen card takes the
 * action's ring and a check in its corner.
 */
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";
import { cn } from "./cn.ts";
import { CheckIcon } from "./icons.tsx";

function OptionCards({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      className={cn("grid w-full gap-3", className)}
      data-slot="option-cards"
      {...props}
    />
  );
}

function OptionCard({
  children,
  className,
  ...props
}: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      className={cn(
        "group/option-card relative flex cursor-pointer select-none rounded-xl border bg-background p-3 text-start transition-[border-color,background-color,box-shadow] hover:border-border-strong data-disabled:cursor-not-allowed data-checked:border-action data-checked:bg-action/5 data-disabled:opacity-50 data-checked:ring-3 data-checked:ring-action/20",
        className
      )}
      data-slot="option-card"
      data-value={String(props.value)}
      {...props}
    >
      {children}
      <span
        aria-hidden="true"
        className="absolute end-2 top-2 flex size-5 scale-75 items-center justify-center rounded-full bg-action text-action-foreground opacity-0 transition group-data-checked/option-card:scale-100 group-data-checked/option-card:opacity-100 [&_svg]:size-3"
      >
        <CheckIcon />
      </span>
    </RadioPrimitive.Root>
  );
}

/** A card's icon, title and the line saying what the choice means. */
function OptionCardBody({
  description,
  icon,
  title,
}: {
  readonly description: ReactNode;
  readonly icon: ReactNode;
  readonly title: ReactNode;
}) {
  return (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle group-data-checked/option-card:bg-background group-data-checked/option-card:text-action [&_svg]:size-icon">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-sm">{title}</span>
        <span className="text-muted-foreground text-xs">{description}</span>
      </span>
    </>
  );
}

export { OptionCard, OptionCardBody, OptionCards };
