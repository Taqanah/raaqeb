/**
 * Which status page a request shows: the
 * host selects the page, the path the view and the locale. On the public
 * address's host, and on any host no page claims, the default page sits at
 * `/` and every page at `/status/<slug>`; a page's custom domain serves that
 * page alone at `/`. The page language is the plain address and the other
 * locale sits under its prefix (`/en`, `/en/status/<slug>`); a prefix in the
 * page's own language is no address. The other views
 * hang from a page's plain address: `/history`, `/history/<yyyy-mm>`,
 * `/incidents/<id>`, `/maintenance/<id>`, and so do
 * its badge and feed, `/badge.svg` and `/feed.atom`, and its summary,
 * `/api/v2/summary.json`, at the plain address alone. A view's JSON document is `/api/pages/<page id>/overview`, or the
 * view's own part after the page id, on any host. An unpublished page
 * resolves at the same addresses, marked so, for the memo to answer the
 * operator alone. Pure: the entry builds the index from the pages
 * and hands every request through here.
 */
import { type Locale, locales } from "@/shared/i18n/locale.ts";
import {
  type PagePaths,
  type PublicView,
  type ResourceName,
  resourceNames,
  resourceSuffixes,
} from "@/shared/schemas/overview.ts";
import { customDomainOf, type StatusPage } from "@/shared/schemas/page.ts";

/** What the index keeps of one page to tell whether a request shows it. */
export interface PublicPageEntry {
  readonly customDomain: string | undefined;
  readonly id: string;
  readonly isDefault: boolean;
  readonly locale: Locale;
  /** An unpublished page resolves for the operator's preview alone, and frames no not-found. */
  readonly published: boolean;
  readonly slug: string;
}

/** Every page as the entry resolves requests against it, and the origin the public address names. */
export interface PublicIndex {
  readonly pages: readonly PublicPageEntry[];
  readonly publicAddress: string | undefined;
}

/** The views of a status page (CONTEXT.md "View"). */
export type ViewName = "history" | "incident" | "maintenance" | "overview";

/** A request that shows one of a page's views in one locale: the page, the locale, the view and the memo's key. */
export interface ViewTarget {
  /** The page id, the locale, the host the request came through and the path: the memo's key. */
  readonly key: string;
  readonly kind: "view";
  readonly locale: Locale;
  readonly pageId: string;
  readonly paths: PagePaths;
  /** Whether the page is published; the memo answers an unpublished one to the signed-in operator alone, outside the memo. */
  readonly published: boolean;
  readonly view: ViewName;
}

/** A request for one of a page's view documents, the same in both locales. */
export interface DocumentTarget {
  readonly key: string;
  readonly kind: "document";
  readonly pageId: string;
  /** Whether the page is published, as on a view's target. */
  readonly published: boolean;
  readonly view: ViewName;
}

/** A request for a page's badge, feed or summary: the page, the locale the badge and feed are written in, and the memo's key. */
export interface ResourceTarget {
  readonly key: string;
  readonly kind: "resource";
  /** The locale of the address; the summary's is the page language, and it carries no words. */
  readonly locale: Locale;
  readonly pageId: string;
  readonly paths: PagePaths;
  /** Whether the page is published; an unpublished page's badge, feed and summary are found by no one. */
  readonly published: boolean;
  readonly resource: ResourceName;
}

export type PublicTarget = DocumentTarget | ResourceTarget | ViewTarget;

/** The index of the pages as they are stored now. */
export function publicIndexOf(
  pages: readonly StatusPage[],
  publicAddress: string | undefined
): PublicIndex {
  return {
    pages: pages.map((page) => ({
      customDomain: page.customDomain,
      id: page.id,
      isDefault: page.isDefault,
      locale: page.locale,
      published: page.published,
      slug: page.slug,
    })),
    publicAddress,
  };
}

const documentPath = /^\/api\/pages\/([^/]+)(\/.*)$/;
const statusPath = /^\/status\/([^/]+)(.*)$/;
const month = "\\d{4}-(?:0[1-9]|1[0-2])";

/** Each view's own part of a path, past the page's plain address. */
const suffixes: readonly (readonly [RegExp, ViewName])[] = [
  [/^$/, "overview"],
  [new RegExp(`^/history(?:/${month})?$`), "history"],
  [/^\/incidents\/[^/]+$/, "incident"],
  [/^\/maintenance\/[^/]+$/, "maintenance"],
];

/** The view a path's own part names, or nothing. */
function viewOf(suffix: string): ViewName | undefined {
  return suffixes.find(([pattern]) => pattern.test(suffix))?.[1];
}

/** A path segment unescaped, or nothing when its escapes are malformed. */
function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape names no page.
    return undefined;
  }
}

/** The other of the two locales. */
function otherLocale(locale: Locale): Locale {
  return locale === "ar" ? "en" : "ar";
}

/** The page's plain address in each locale, with no trailing slash: its own language plain, the other under the prefix. */
function basesOf(page: PublicPageEntry, plain: string): Record<Locale, string> {
  const own = plain === "/" ? "" : plain;
  const prefixed = `/${otherLocale(page.locale)}${own}`;
  return page.locale === "ar"
    ? { ar: own, en: prefixed }
    : { ar: prefixed, en: own };
}

/** The document a path asks for, when it names a view of a page the index holds. */
function documentTarget(
  index: PublicIndex,
  pathname: string
): DocumentTarget | undefined {
  const [, rawId = "", rawSuffix = ""] = documentPath.exec(pathname) ?? [];
  const pageId = decoded(rawId);
  const page = index.pages.find((each) => each.id === pageId);
  if (!(pageId && page)) {
    return;
  }
  // A malformed escape empties its segment, which no view's address has.
  const suffix = rawSuffix
    .split("/")
    .map((part) => decoded(part) ?? "")
    .join("/");
  // The overview's document is `/overview`; every other view's is its own address after the page id.
  const view = suffix === "/overview" ? "overview" : viewOf(suffix);
  if (!view) {
    return;
  }
  return {
    key: `${pageId} document ${suffix}`,
    kind: "document",
    pageId,
    published: page.published,
    view,
  };
}

/** The page a path past its locale prefix shows on the host, its plain address there, and the view's own part of the path. */
function pageAt(
  index: PublicIndex,
  claimed: PublicPageEntry | undefined,
  tail: string
): { page: PublicPageEntry | undefined; plain: string; suffix: string } {
  const bare = tail === "/" ? "" : tail;
  if (claimed) {
    // A custom domain serves its own page alone.
    return { page: claimed, plain: "/", suffix: bare };
  }
  const status = statusPath.exec(tail);
  if (!status) {
    return {
      page: index.pages.find((each) => each.isDefault),
      plain: "/",
      suffix: bare,
    };
  }
  const [, slug, suffix = ""] = status;
  const page = index.pages.find((each) => each.slug === slug);
  return { page, plain: page?.isDefault ? "/" : `/status/${slug}`, suffix };
}

/** A page's addresses as its messages name them, whatever host a request came through: on its custom domain, else on the public address, at its plain address there (a subscriber's links). */
export function canonicalPaths(
  page: PublicPageEntry,
  publicAddress: string | undefined
): PagePaths {
  if (page.customDomain) {
    return {
      bases: basesOf(page, "/"),
      origin: `https://${page.customDomain}`,
    };
  }
  return {
    bases: basesOf(page, page.isDefault ? "/" : `/status/${page.slug}`),
    origin: publicAddress,
  };
}

/** The view, document, summary, badge or feed a request shows, or nothing for any other request. `host` is the host the entry resolved behind the trusted proxies. */
export function publicTarget(
  index: PublicIndex,
  host: string | undefined,
  pathname: string
): PublicTarget | undefined {
  if (pathname.startsWith("/api/pages/")) {
    return documentTarget(index, pathname);
  }
  // One address per document: a trailing slash reads as the path without it.
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  const [, first = "", ...rest] = path.split("/");
  const prefix = locales.find((each) => each === first);
  const tail = prefix ? `/${rest.join("/")}` : path;
  const domain = host === undefined ? undefined : customDomainOf(host);
  const claimed = index.pages.find(
    (each) => domain !== undefined && each.customDomain === domain
  );
  const { page, plain, suffix } = pageAt(index, claimed, tail);
  // A prefix names the other locale only: the page's own is its plain address.
  if (!page || prefix === page.locale) {
    return;
  }
  const locale = prefix ?? page.locale;
  const shown = {
    key: `${page.id} ${locale} ${claimed ? "domain" : "main"} ${path}`,
    locale,
    pageId: page.id,
    published: page.published,
    paths: {
      bases: basesOf(page, plain),
      origin: claimed ? `https://${claimed.customDomain}` : index.publicAddress,
    },
  };
  const view = viewOf(suffix);
  if (view) {
    return { ...shown, kind: "view", view };
  }
  const resource = resourceNames.find(
    (name) => resourceSuffixes[name] === suffix
  );
  // The summary carries no words: one address, the page's own.
  if (!resource || (resource === "summary" && prefix)) {
    return;
  }
  return { ...shown, kind: "resource", resource };
}

/** The page whose frame a not-found shows at an address that names no view: the page its `/status/<slug>` names, else the one the host shows at its bare address, in the page language; the not-found takes the document's locale. Nothing when the host shows no published page. */
export function missingView(
  index: PublicIndex,
  host: string | undefined,
  pathname: string
): PublicView | undefined {
  const parts = pathname.split("/").slice(1);
  const prefixed = locales.some((each) => each === parts[0]);
  const [first, slug] = prefixed ? parts.slice(1) : parts;
  // Each a page's plain address: the slug's page, then the host's own.
  const tried = [
    ...(first === "status" && slug ? [`/status/${slug}`] : []),
    "/",
  ];
  for (const path of tried) {
    const target = publicTarget(index, host, path);
    // An unpublished page frames nothing a visitor sees.
    if (target?.kind === "view" && target.published) {
      return {
        locale: target.locale,
        pageId: target.pageId,
        paths: target.paths,
      };
    }
  }
}
