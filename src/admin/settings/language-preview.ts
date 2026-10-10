/**
 * A language previewed before it is saved: picking
 * one renders the page in it at once, through the ?locale= the general and
 * account pages accept, and leaving the page without saving renders the
 * admin in the saved language again. The root reads its language only when
 * told to, so each step re-reads it.
 */
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import type { Locale } from "@/shared/i18n/locale.ts";

/** Shows the page in `locale`, or in the saved language for none; `show` puts it in the address. */
export function useLanguagePreview(
  show: (locale: Locale | undefined) => Promise<void>
): (locale: Locale | undefined) => void {
  const router = useRouter();
  const shown = useRef<boolean>(false);
  // Leaving the page drops ?locale= from the address; the root reads its language again without it.
  useEffect(
    () => () => {
      if (shown.current) {
        router.invalidate().catch(() => undefined);
      }
    },
    [router]
  );
  return useCallback(
    (locale: Locale | undefined) => {
      shown.current = true;
      show(locale)
        .then(() => router.invalidate())
        .catch(() => undefined);
    },
    [router, show]
  );
}
