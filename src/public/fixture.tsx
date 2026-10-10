/**
 * What the public UI's render tests share: a status page view and a render
 * in a locale's catalog under a router, since a view's links are router
 * links. Tests only; nothing in the app imports it.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import type { Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import type { OverviewPage, PublicView } from "@/shared/schemas/overview.ts";
import type { HistoryDocument } from "@/shared/schemas/views.ts";
import { messages as ar } from "../../locales/ar/messages.ts";
import { messages as en } from "../../locales/en/messages.ts";

/** An English page that customizes nothing. */
export const plainPage: OverviewPage = {
  footerLinks: [],
  id: "p",
  images: {},
  labels: {},
  locale: "en",
  noindex: false,
  poweredBy: true,
  statusColours: {},
  theme: "system",
  title: { en: "Example status" },
};

/** September 2026's history of the page, empty, on an install in Hijri with the Gregorian beside it. */
export const september: HistoryDocument = {
  calendar: "hijri_gregorian",
  clock: "12h",
  entries: [],
  month: "2026-09",
  page: plainPage,
  timeZone: "Asia/Riyadh",
};

/** The page's view at the bare host in a locale. */
export function viewIn(locale: Locale): PublicView {
  return {
    locale,
    pageId: plainPage.id,
    paths: { bases: { ar: "/ar", en: "" }, origin: undefined },
  };
}

/** The markup the server writes for a node in the locale. */
export function render(locale: Locale, node: ReactNode): string {
  const router = createRouter({
    history: createMemoryHistory(),
    routeTree: createRootRoute(),
  });
  return renderToString(
    <RouterContextProvider router={router}>
      <MessagesProvider
        i18n={createMessages(locale, locale === "ar" ? ar : en)}
      >
        {node}
      </MessagesProvider>
    </RouterContextProvider>
  );
}
