import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageMissing, PlainMissing } from "@/public/views.tsx";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Route as Root } from "./__root.tsx";
import { missingOf } from "./-public.ts";

/**
 * The not-found: inside the frame of the page
 * the entry resolved, or of the page the address or the host names, with
 * the way back to its overview; the same words without a frame when no
 * page is known. The router's default for every route, so a visitor never
 * sees its English one. Where the entry resolved no page, the frame takes
 * the document's locale, the install language, and its language switch
 * leads to the page's overview, since the address names no view. Not a route file: the leading dash keeps it out of the route
 * tree.
 */
export function ViewMissing({ data }: { readonly data?: unknown }): ReactNode {
  const resolved = Root.useLoaderData()?.view;
  const { locale } = useMessages();
  const pathname = useLocation({ select: (location) => location.pathname });
  const missing = missingOf(data);
  if (missing && resolved) {
    // The address past the page's plain address, so the language switch keeps it.
    const suffix = pathname.slice(resolved.paths.bases[resolved.locale].length);
    return (
      <PageMissing frame={missing.frame} suffix={suffix} view={resolved} />
    );
  }
  if (missing?.view) {
    return (
      <PageMissing
        frame={missing.frame}
        suffix=""
        view={{ ...missing.view, locale }}
      />
    );
  }
  return <PlainMissing />;
}
