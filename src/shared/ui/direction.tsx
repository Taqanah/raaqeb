import { DirectionProvider as DirectionProviderPrimitive } from "@base-ui/react/direction-provider";
import type { ReactNode } from "react";
import type { Direction } from "@/shared/i18n/locale.ts";

export interface DirectionProviderProps {
  readonly children: ReactNode;
  readonly direction: Direction;
}

// Base UI reads the reading direction from context, not from the document's
// dir attribute, so keyboard order and popup sides follow the locale
// (docs/deps/base-ui, utils/direction-provider). The root shell mounts one.
export function DirectionProvider({
  children,
  direction,
}: DirectionProviderProps): ReactNode {
  return (
    <DirectionProviderPrimitive direction={direction}>
      {children}
    </DirectionProviderPrimitive>
  );
}
