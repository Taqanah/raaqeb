import { Input as InputPrimitive } from "@base-ui/react/input";
import { type ComponentProps, useId } from "react";
import { cn } from "./cn.ts";

export type InputProps = ComponentProps<"input"> & {
  /** The unit a number is in, shown muted at the field's end and read with it. */
  readonly unit?: string;
  /** A machine token is typed here: a URL, a host, a header name, a key. */
  readonly variant?: "token";
};

// The box: border, fill, focus ring and refusal. With a unit it moves to the wrapper and follows the input inside it.
const box =
  "h-control w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm transition-[border-color,box-shadow]";
const alone =
  "py-1 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm placeholder:text-muted-foreground focus-visible:border-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-status-down aria-invalid:ring-4 aria-invalid:ring-status-down/15";
const grouped =
  "flex items-center gap-2 has-disabled:cursor-not-allowed has-aria-invalid:border-status-down has-focus-visible:border-ring has-disabled:bg-muted has-disabled:opacity-50 has-aria-invalid:ring-4 has-aria-invalid:ring-status-down/15 has-focus-visible:focus-ring";

function Input({
  "aria-describedby": describedBy,
  className,
  dir,
  type,
  unit,
  value,
  variant,
  ...props
}: InputProps) {
  const token = variant === "token";
  const unitId = useId();
  const field = (
    <InputPrimitive
      aria-describedby={
        unit ? [describedBy, unitId].filter(Boolean).join(" ") : describedBy
      }
      className={cn(
        unit
          ? "h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground disabled:pointer-events-none"
          : [box, alone],
        token && "font-mono",
        !unit && className
      )}
      data-slot="input"
      type={type}
      value={value}
      {...props}
      // A token is left to right and never spell-checked, as the token component is, whatever the caller passes; an empty free-text field follows the page: "auto" reads an empty value as left to right.
      {...(token
        ? { dir: "ltr", spellCheck: false }
        : { dir: dir === "auto" && value === "" ? undefined : dir })}
    />
  );
  if (!unit) {
    return field;
  }
  return (
    <div className={cn(box, grouped, className)} data-slot="input-group">
      {field}
      <span className="shrink-0 select-none text-muted-foreground" id={unitId}>
        {unit}
      </span>
    </div>
  );
}

export { Input };
