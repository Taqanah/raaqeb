import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn.ts";

// Direction B: 40 px controls, a teal primary with a soft ring
// on hover, a white secondary with the 1 px border. A keyboard shortcut chip
// is a <Kbd> as the last child; the chip styling reacts to the button. A button
// disabled yet focusable (a form's Save) carries aria-disabled and dims alike.
const variants = cva(
  "group/button inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-transparent bg-clip-padding font-medium text-sm outline-none transition-[background-color,border-color,box-shadow,color,transform] focus-visible:ring-4 focus-visible:ring-ring-soft active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive [&>[data-slot=kbd]]:ms-1 [&_svg:not([class*='size-'])]:size-icon [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-control px-3",
        icon: "size-control",
        sm: "h-control gap-1.5 px-2.5",
      },
      variant: {
        default:
          "border-action bg-action text-action-foreground hover:ring-4 hover:ring-action/25 focus-visible:ring-action/25 [&>[data-slot=kbd]]:bg-action-foreground/20 [&>[data-slot=kbd]]:text-action-foreground",
        destructive:
          "border-status-down bg-status-down text-destructive-foreground hover:ring-4 hover:ring-status-down/25 focus-visible:ring-status-down/25 [&>[data-slot=kbd]]:bg-destructive-foreground/20 [&>[data-slot=kbd]]:text-destructive-foreground",
        // A button that leads to deleting something: the outline's shape in the destructive text colour.
        "destructive-outline":
          "border-border bg-background text-destructive-text hover:bg-status-down-soft aria-expanded:bg-status-down-soft",
        ghost:
          "hover:bg-subtle hover:text-foreground aria-expanded:bg-subtle aria-expanded:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        outline:
          "border-border bg-background text-foreground hover:bg-muted aria-expanded:bg-subtle",
        secondary:
          "bg-subtle text-secondary-foreground hover:bg-border aria-expanded:bg-border",
      },
    },
  }
);

type ButtonVariants = VariantProps<typeof variants>;

/** The classes of a button, merged so a variant's border wins over the base's transparent one on a link styled as a button too. */
function buttonVariants(props?: Parameters<typeof variants>[0]): string {
  return cn(variants(props));
}

export type ButtonProps = ButtonPrimitive.Props & ButtonVariants;

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      className={buttonVariants({ className, size, variant })}
      data-slot="button"
      {...props}
    />
  );
}

export { Button, buttonVariants };
