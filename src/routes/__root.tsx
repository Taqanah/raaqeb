import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useMemo } from "react";
import { z } from "zod";
import { readAppearance } from "@/server/settings/appearance.ts";
import {
  documentLanguage,
  publicDocumentLanguage,
  requestedLocale,
} from "@/server/settings/language.ts";
import {
  isAdminPath,
  readOperatorLanguage,
} from "@/server/settings/operator.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { subscriptionView } from "@/server/subscriptions/subscriptions.ts";
import { fallbackCatalog } from "@/shared/i18n/fallback.ts";
import {
  defaultLocale,
  directionOf,
  type Locale,
  localeSchema,
} from "@/shared/i18n/locale.ts";
import { catalogFromJson, createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import {
  type Appearance,
  defaultAppearance,
} from "@/shared/schemas/appearance.ts";
import type { PublicView } from "@/shared/schemas/overview.ts";
import { subscriptionTokenOf } from "@/shared/schemas/subscription.ts";
import { raaqebIcons } from "@/shared/ui/app-icons.ts";
import { appearanceAttributes } from "@/shared/ui/appearance.ts";
import { DirectionProvider } from "@/shared/ui/direction.tsx";
import plexMono from "@/shared/ui/fonts/plex-mono-regular.woff2?url";
import rubikArabic from "@/shared/ui/fonts/rubik-arabic.woff2?url";
import rubikLatin from "@/shared/ui/fonts/rubik-latin.woff2?url";
import { TooltipProvider } from "@/shared/ui/tooltip.tsx";
import "@/styles.css";

// The install language decides the document's lang, dir and inlined catalog,
// unless the page is one whose switcher may ask for the other
// locale through ?locale= (sign-in, sign-out, onboarding), or an admin page,
// which renders in the operator language; the appearance settings
// ride along as data attributes for the first paint. The storage
// arrives as Start's request context from the Bun.serve entry; without one
// (onboarding, `vite dev`) the defaults hold. A status page's view, which
// the entry resolved before the memo looked, renders in the locale its URL
// names with the public part of the catalog and none of the admin's
// appearance: a visitor gets the theme alone, set by the view's own script. Its title is the page's, which the view sets.
const readDocument = createServerFn()
  .validator(
    z.object({
      admin: z.boolean(),
      locale: localeSchema.optional(),
      subscription: z.string().optional(),
    })
  )
  .handler(async ({ context, data }) => {
    const target = context.publicTarget;
    // A subscription's own page renders like a view, in the subscription language.
    const shown: PublicView | undefined =
      target?.kind === "view"
        ? {
            locale: target.locale,
            pageId: target.pageId,
            paths: target.paths,
            // Only the signed-in operator is handed an unpublished page's view.
            preview: !target.published,
          }
        : await subscriptionPage(context.storage, data.subscription);
    if (shown) {
      const { catalog, dir, locale } = await publicDocumentLanguage(
        shown.locale
      );
      const view: PublicView = { ...shown, locale };
      return {
        appearance: defaultAppearance,
        catalog: JSON.stringify(catalog),
        dir,
        locale,
        title: "",
        view,
      };
    }
    const requested =
      data.locale ??
      (data.admin ? await readOperatorLanguage(context.storage) : undefined);
    const [{ catalog, dir, locale, title }, appearance] = await Promise.all([
      documentLanguage(context.storage, requested),
      readAppearance(context.storage),
    ]);
    // The compiled catalog travels as JSON text: its token type is not one Start can check for serializability.
    return {
      appearance,
      catalog: JSON.stringify(catalog),
      dir,
      locale,
      title,
      view: undefined,
    };
  });

/** The page a subscription's own page renders in, for its token; nothing for any other path or an unknown token. */
function subscriptionPage(
  storage: Storage | undefined,
  token: string | undefined
): Promise<PublicView | undefined> {
  return storage && token !== undefined
    ? subscriptionView(storage, token)
    : Promise.resolve(undefined);
}

interface DocumentData {
  readonly appearance: Appearance;
  readonly catalog: string;
  readonly dir: "rtl" | "ltr";
  readonly locale: Locale;
  readonly title: string;
  /** The status page view the document shows; nothing for any other page. */
  readonly view: PublicView | undefined;
}

// When the loader itself failed (the database is gone), the shell still
// renders a document, in the Arabic default with only the error notice's
// words for its catalog, for the error.
const fallback: DocumentData = {
  appearance: defaultAppearance,
  catalog: JSON.stringify(fallbackCatalog(defaultLocale)),
  dir: directionOf(defaultLocale),
  locale: defaultLocale,
  title: "",
  view: undefined,
};

/** A font every page draws with, fetched beside the scripts rather than a round trip after the stylesheet names it. */
function fontPreload(href: string) {
  return {
    as: "font",
    crossOrigin: "anonymous" as const,
    href,
    rel: "preload",
    type: "font/woff2",
  };
}

export const Route = createRootRoute({
  head: ({ loaderData }) => ({
    // Arabic text only where the document is Arabic; Latin covers digits and the mono font machine tokens, on every page.
    links: [
      ...((loaderData?.locale ?? fallback.locale) === "ar"
        ? [fontPreload(rubikArabic)]
        : []),
      fontPreload(rubikLatin),
      fontPreload(plexMono),
      // A status page's view writes its own icon links.
      ...(loaderData?.view ? [] : raaqebIcons),
    ],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      // A status page's view writes its own title.
      ...(loaderData?.view
        ? []
        : [{ title: loaderData?.title ?? fallback.title }]),
    ],
  }),
  // The parameter is annotated by hand: reading the typed search here would
  // make the registered router's type depend on this route, and TypeScript
  // then infers the loader as nothing.
  loader: ({ location }: { location: { pathname: string; search: unknown } }) =>
    readDocument({
      data: {
        admin: isAdminPath(location.pathname),
        locale: requestedLocale(location.pathname, location.search),
        subscription: subscriptionTokenOf(location.pathname),
      },
    }),
  shellComponent: RootDocument,
  // In the browser the root's loader would read the document through a
  // server function, which cannot know the status page the entry resolved:
  // a view's live refresh would lose its page. The
  // admin's own invalidate still reloads it.
  shouldReload: false,
});

function RootDocument({ children }: { children: ReactNode }) {
  const data: DocumentData | undefined = Route.useLoaderData();
  const { appearance, catalog, dir, locale } = data ?? fallback;
  const i18n = useMemo(
    () => createMessages(locale, catalogFromJson(catalog)),
    [locale, catalog]
  );
  return (
    // A status page's theme script may change data-theme before React hydrates (ADR-0006).
    <html
      dir={dir}
      lang={locale}
      {...appearanceAttributes(appearance)}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
      </head>
      <body>
        <MessagesProvider i18n={i18n}>
          <DirectionProvider direction={dir}>
            <TooltipProvider>{children}</TooltipProvider>
          </DirectionProvider>
        </MessagesProvider>
        <Scripts />
      </body>
    </html>
  );
}
