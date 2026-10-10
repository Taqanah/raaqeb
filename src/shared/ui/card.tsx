import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

// A rounded-xl card lifted by its rim and a soft shadow, no grey border; `as` keeps a public card's article or section.
function Card({
  as: Element = "div",
  className,
  size = "default",
  ...props
}: ComponentProps<"div"> & {
  as?: "article" | "div" | "section";
  size?: "default" | "sm";
}) {
  return (
    <Element
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-card-foreground text-sm ring-line [--card-spacing:--spacing(4)] has-[>img:first-child]:pt-0 has-data-[slot=card-footer]:pb-0 data-[size=sm]:has-data-[slot=card-footer]:pb-0 data-[size=sm]:[--card-spacing:--spacing(3)]",
        className
      )}
      data-size={size}
      data-slot="card"
      {...props}
    />
  );
}

// A form card's header is divided from its fields; a card that shows a record is not.
function CardHeader({
  className,
  divided = false,
  ...props
}: ComponentProps<"div"> & { divided?: boolean }) {
  return (
    <div
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 px-(--card-spacing) has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        divided && "border-b",
        className
      )}
      data-slot="card-header"
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "font-medium text-base leading-snug group-data-[size=sm]/card:text-sm",
        className
      )}
      data-slot="card-title"
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="card-description"
      {...props}
    />
  );
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("px-(--card-spacing)", className)}
      data-slot="card-content"
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center border-t bg-muted p-(--card-spacing)",
        className
      )}
      data-slot="card-footer"
      {...props}
    />
  );
}

export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
};
