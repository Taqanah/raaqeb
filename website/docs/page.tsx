/**
 * A docs page: Fumadocs' docs layout under the website's own
 * header, with the sidebar, the outline, search, and a button that copies
 * the page as Markdown. The theme is the website's: the root script and the
 * header's button set it, so Fumadocs' own theme provider stays off.
 */

import type { SharedProps } from "@fumadocs/base-ui/components/dialog/search";
import { i18nProvider } from "@fumadocs/base-ui/i18n";
import { DocsLayout } from "@fumadocs/base-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
} from "@fumadocs/base-ui/layouts/docs/page";
import { RootProvider } from "@fumadocs/base-ui/provider/tanstack";
import { Link } from "@tanstack/react-router";
import type * as PageTree from "fumadocs-core/page-tree";
import {
  type ComponentProps,
  lazy,
  type ReactNode,
  Suspense,
  use,
  useState,
} from "react";
import { directionOf, type Locale } from "@/shared/i18n/locale.ts";
import { copies } from "~/copy.ts";
import { homePath } from "~/locale.ts";
import { DocsHeader, DocsPhoneHeader } from "./header.tsx";
import { translations } from "./interface.ts";
import { mdxComponents } from "./mdx.tsx";
import { docs } from "./source.ts";
// Imported by the component, not the route, so only docs pages carry Fumadocs' styles.
import "./styles.css";
import "./highlight.css";

// The dialog, its engine and its index weigh more than the page, so they load when the visitor first opens search.
const DocsSearch = lazy(() => import("./search.tsx"));

function SearchOnceOpened(props: SharedProps): ReactNode {
  const [opened, setOpened] = useState(props.open);
  if (props.open && !opened) {
    setOpened(true);
  }
  return opened ? <DocsSearch {...props} /> : null;
}

export interface DocsPageData {
  readonly locale: Locale;
  readonly markdownUrl: string;
  /** The same page in the other language, or that language's docs. */
  readonly otherUrl: string;
  readonly path: string;
  readonly tree: PageTree.Root;
}

export function DocsView({
  locale,
  markdownUrl,
  otherUrl,
  path,
  tree,
}: DocsPageData): ReactNode {
  return (
    <RootProvider
      components={{ Link: DocsLink }}
      dir={directionOf(locale)}
      i18n={i18nProvider(translations, locale)}
      search={{ SearchDialog: SearchOnceOpened }}
      theme={{ enabled: false }}
    >
      <DocsHeader locale={locale} otherUrl={otherUrl} />
      <DocsLayout
        nav={{
          component: <DocsPhoneHeader locale={locale} otherUrl={otherUrl} />,
          title: copies[locale].brand,
          url: homePath[locale],
        }}
        // The header holds search, the language and the theme, so the sidebar repeats none of them.
        slots={{
          languageSelect: false,
          searchTrigger: false,
          themeSwitch: false,
        }}
        tree={tree}
      >
        {/* Names the Markdown copy, so the prerender's crawl writes it. */}
        <Link hidden to={markdownUrl} />
        <Suspense>
          <Content markdownUrl={markdownUrl} path={path} />
        </Suspense>
      </DocsLayout>
    </RootProvider>
  );
}

function Content({
  markdownUrl,
  path,
}: {
  readonly markdownUrl: string;
  readonly path: string;
}): ReactNode {
  const page = docs.getPage(path);
  if (!page) {
    throw new Error(`no docs page at ${path}`);
  }
  const { toc } = use(page.load());
  const Body = page.body;
  return (
    <DocsPage toc={toc}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <div className="docs-actions -mt-4 flex items-center gap-2 border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
      </div>
      <DocsBody>
        <Body components={mdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

/**
 * Fumadocs' links: inside the docs they move in the app, as its own TanStack
 * link does; out of them, to the landing page, they load the page whole, so
 * the docs' stylesheet never stays on a page that has its own.
 */
function DocsLink({
  children,
  href = "",
  prefetch = true,
  ...props
}: ComponentProps<"a"> & { readonly prefetch?: boolean }): ReactNode {
  if (!(href.startsWith("/docs") || href.startsWith("/en/docs"))) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }
  return (
    <Link preload={prefetch ? "intent" : false} to={href} {...props}>
      {children}
    </Link>
  );
}
