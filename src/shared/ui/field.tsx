import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentProps, useMemo } from "react";
import { cn } from "./cn.ts";
import { Label } from "./label.tsx";

function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/field-group @container/field-group flex w-full flex-col gap-5 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4",
        className
      )}
      data-slot="field-group"
      {...props}
    />
  );
}

const fieldVariants = cva(
  "group/field flex w-full gap-2 data-[invalid=true]:text-status-down",
  {
    defaultVariants: {
      orientation: "vertical",
    },
    variants: {
      orientation: {
        horizontal: "flex-row items-center *:data-[slot=field-label]:flex-auto",
        responsive:
          "@md/field-group:flex-row flex-col @md/field-group:items-center *:w-full @md/field-group:*:w-auto @md/field-group:*:data-[slot=field-label]:flex-auto [&>.sr-only]:w-auto",
        vertical: "flex-col *:w-full [&>.sr-only]:w-auto",
      },
    },
  }
);

function Field({
  className,
  orientation = "vertical",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      className={cn(fieldVariants({ orientation }), className)}
      data-orientation={orientation}
      data-slot="field"
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return (
    <Label
      className={cn(
        "group/field-label peer/field-label has-[>[data-slot=field]]:has-[:focus-visible]:focus-ring flex w-fit gap-2 leading-snug has-[>[data-slot=field]]:has-[:focus-visible]:border-ring has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-lg has-[>[data-slot=field]]:border has-data-checked:border-action/30 has-data-checked:bg-action/5 has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:hover:bg-muted *:data-[slot=field]:p-3 group-data-[disabled=true]/field:opacity-50",
        className
      )}
      data-slot="field-label"
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "text-start font-normal text-muted-foreground text-xs leading-normal group-has-data-horizontal/field:text-balance",
        "nth-last-2:-mt-1 last:mt-0",
        "[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4",
        className
      )}
      data-slot="field-description"
      {...props}
    />
  );
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: ComponentProps<"div"> & {
  errors?: Array<{ message?: string } | undefined>;
}) {
  const content = useMemo(() => {
    if (children) {
      return children;
    }
    const messages = [
      ...new Set(
        (errors ?? []).flatMap((error) =>
          error?.message ? [error.message] : []
        )
      ),
    ];
    if (messages.length === 0) {
      return null;
    }
    if (messages.length === 1) {
      return messages[0];
    }
    return (
      <ul className="ms-4 flex list-disc flex-col gap-1">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    );
  }, [children, errors]);

  if (!content) {
    return null;
  }

  return (
    <div
      className={cn("font-normal text-status-down text-xs", className)}
      data-slot="field-error"
      role="alert"
      {...props}
    >
      {content}
    </div>
  );
}

export { Field, FieldDescription, FieldError, FieldGroup, FieldLabel };
