/**
 * What a status page's view routes share (ADR-0006):
 * each view's loader, which reads the same function its JSON document
 * answers with while the server renders and fetches the document's URL in
 * the browser, so no public loader calls a server function; the page the
 * entry resolved, which the root's loader hands down; the head a view
 * writes; and the Cache-Control that lets the memo keep it. A view with
 * nothing at its address is not found inside the page's frame. Not a route file: the leading dash keeps it out of the
 * route tree.
 */
import { isNotFound, notFound } from "@tanstack/react-router";
import {
  createIsomorphicFn,
  getGlobalStartContext,
} from "@tanstack/react-start";
import { z } from "zod";
import { themeScript } from "@/public/theme.tsx";
import { readOverview } from "@/server/pages/overview.ts";
import {
  readHistory,
  readIncidentView,
  readMaintenanceView,
  readViewFrame,
  type ViewResult,
} from "@/server/pages/views.ts";
import { formatMonth } from "@/shared/i18n/format.ts";
import { locales } from "@/shared/i18n/locale.ts";
import { type Content, contentIn } from "@/shared/schemas/content.ts";
import {
  feedUrl,
  type OverviewDocument,
  overviewDocumentSchema,
  overviewUrl,
  type PublicView,
  publicPolicy,
  publicViewSchema,
  viewPath,
} from "@/shared/schemas/overview.ts";
import {
  type HistoryDocument,
  historyDocumentSchema,
  historyUrl,
  type IncidentDocument,
  incidentDocumentSchema,
  incidentUrl,
  type MaintenanceDocument,
  type Month,
  maintenanceDocumentSchema,
  maintenanceUrl,
  monthSchema,
  type ViewFrame,
  viewFrameSchema,
} from "@/shared/schemas/views.ts";
import { faviconLinks } from "@/shared/ui/app-icons.ts";

/** Which document a view asks for. */
type ViewRequest =
  | { readonly kind: "history"; readonly month: Month | undefined }
  | { readonly kind: "incident"; readonly id: string }
  | { readonly kind: "maintenance"; readonly id: string }
  | { readonly kind: "overview" };

/** A view's document, by the view it belongs to. */
type ViewDocument =
  | { readonly document: HistoryDocument; readonly kind: "history" }
  | { readonly document: IncidentDocument; readonly kind: "incident" }
  | { readonly document: MaintenanceDocument; readonly kind: "maintenance" }
  | { readonly document: OverviewDocument; readonly kind: "overview" };

/** A view's document, or the page's frame when nothing is at the address (nothing at all for an unknown page). */
type ViewAnswer =
  | { readonly found: true; readonly view: ViewDocument }
  | { readonly found: false; readonly frame: ViewFrame | undefined };

/** A server read's answer; a database that did not answer fails the render (the document route answers 503). */
function answerOf<Document>(
  result: ViewResult<Document>,
  view: (document: Document) => ViewDocument
): ViewAnswer {
  if (result.ok) {
    return { found: true, view: view(result.document) };
  }
  if (result.reason === "not_found") {
    return { found: false, frame: result.frame };
  }
  throw new Error("the view could not be read");
}

const readView = createIsomorphicFn()
  .server(async (pageId: string, request: ViewRequest): Promise<ViewAnswer> => {
    const storage = getGlobalStartContext()?.storage;
    if (!storage) {
      return { found: false, frame: undefined };
    }
    const now = Date.now();
    switch (request.kind) {
      case "overview":
        return answerOf(
          await readOverview(storage, pageId, now),
          (document: OverviewDocument) => ({ document, kind: "overview" })
        );
      case "history":
        return answerOf(
          await readHistory(storage, pageId, request.month, now),
          (document: HistoryDocument) => ({ document, kind: "history" })
        );
      case "incident":
        return answerOf(
          await readIncidentView(storage, pageId, request.id),
          (document: IncidentDocument) => ({ document, kind: "incident" })
        );
      default:
        return answerOf(
          await readMaintenanceView(storage, pageId, request.id),
          (document: MaintenanceDocument) => ({
            document,
            kind: "maintenance",
          })
        );
    }
  })
  .client(async (pageId: string, request: ViewRequest): Promise<ViewAnswer> => {
    const get = async (url: string): Promise<unknown> => {
      // The browser's cache sends the ETag it holds; the memo answers 304 while nothing changed.
      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (response.status === 404) {
        return;
      }
      if (!response.ok) {
        throw new Error("the view could not be read");
      }
      return await response.json();
    };
    const missing = async (): Promise<ViewAnswer> => {
      const overview = await get(overviewUrl(pageId));
      return {
        found: false,
        frame:
          overview === undefined ? undefined : viewFrameSchema.parse(overview),
      };
    };
    switch (request.kind) {
      case "overview": {
        const body = await get(overviewUrl(pageId));
        return body === undefined
          ? { found: false, frame: undefined }
          : {
              found: true,
              view: {
                document: overviewDocumentSchema.parse(body),
                kind: "overview",
              },
            };
      }
      case "history": {
        const body = await get(historyUrl(pageId, request.month));
        return body === undefined
          ? await missing()
          : {
              found: true,
              view: {
                document: historyDocumentSchema.parse(body),
                kind: "history",
              },
            };
      }
      case "incident": {
        const body = await get(incidentUrl(pageId, request.id));
        return body === undefined
          ? await missing()
          : {
              found: true,
              view: {
                document: incidentDocumentSchema.parse(body),
                kind: "incident",
              },
            };
      }
      default: {
        const body = await get(maintenanceUrl(pageId, request.id));
        return body === undefined
          ? await missing()
          : {
              found: true,
              view: {
                document: maintenanceDocumentSchema.parse(body),
                kind: "maintenance",
              },
            };
      }
    }
  });

/**
 * What a view's loader reads, typed by hand: reading the root's match through
 * the registered router would make this route's type depend on itself, and
 * TypeScript then infers its loader data as nothing (as the root's loader met
 * did).
 */
export interface ViewLoaderOptions {
  readonly params: { readonly locale?: string };
  readonly parentMatchPromise: Promise<{
    readonly loaderData?: { readonly view: PublicView | undefined };
  }>;
}

/** What a view's not-found carries, so the page's frame can say so: the frame, when the page exists, and the page's view where the entry resolved none. */
export interface MissingData {
  readonly frame: ViewFrame;
  readonly view?: PublicView;
}

/** A not-found's data where the entry resolved no page: the frame of the page the address or the host names, read on the server; the memo's pages index names the page, so an address no page frames costs no read. Nothing in the browser, where the root's page stands. */
const readMissingData = createIsomorphicFn()
  .server(async (): Promise<MissingData | undefined> => {
    const context = getGlobalStartContext();
    const view = context?.missingView?.();
    if (!(view && context?.storage)) {
      return;
    }
    const frame = await readViewFrame(context.storage, view.pageId);
    // A frame that cannot be read leaves the not-found without one.
    return frame.ok ? { frame: frame.document, view } : undefined;
  })
  .client(() => Promise.resolve(undefined));

/** Whether the address is an unpublished page's, which a visitor finds nothing at, from the memo's pages index on the server; never in the browser, where the root's page stands. */
export const atUnpublishedPage = createIsomorphicFn()
  .server((): boolean => getGlobalStartContext()?.unpublished?.() ?? false)
  .client((): boolean => false);

/** The view's document for the page the root resolved; not found with the page's frame when nothing is at the address. */
async function load(
  view: PublicView | undefined,
  request: ViewRequest
): Promise<ViewDocument> {
  if (!view) {
    throw notFound({ data: await readMissingData() });
  }
  const answer = await readView(view.pageId, request);
  if (!answer.found) {
    const data: MissingData | undefined = answer.frame
      ? { frame: answer.frame }
      : undefined;
    throw notFound({ data });
  }
  return answer.view;
}

/** A view's loaded data: its document and the page the entry resolved. */
export interface ViewData<Document> {
  readonly document: Document;
  readonly view: PublicView;
}

export type OverviewData = ViewData<OverviewDocument>;

const mismatch = () => new Error("the view answered another view's document");

export async function loadOverview(
  view: PublicView | undefined
): Promise<OverviewData> {
  const answer = await load(view, { kind: "overview" });
  if (answer.kind !== "overview" || !view) {
    throw mismatch();
  }
  return { document: answer.document, view };
}

/** The history of a month, the current one with none named; a month that is not one is not found, like one outside the history. */
export async function loadHistory(
  view: PublicView | undefined,
  month?: string
): Promise<ViewData<HistoryDocument>> {
  const parsed = month === undefined ? undefined : monthSchema.safeParse(month);
  if (parsed && !parsed.success) {
    // The entry resolves no such address, so the page the address names frames it.
    throw notFound({ data: await readMissingData() });
  }
  const answer = await load(view, { kind: "history", month: parsed?.data });
  if (answer.kind !== "history" || !view) {
    throw mismatch();
  }
  return { document: answer.document, view };
}

export async function loadIncident(
  view: PublicView | undefined,
  id: string
): Promise<ViewData<IncidentDocument>> {
  const answer = await load(view, { id, kind: "incident" });
  if (answer.kind !== "incident" || !view) {
    throw mismatch();
  }
  return { document: answer.document, view };
}

export async function loadMaintenance(
  view: PublicView | undefined,
  id: string
): Promise<ViewData<MaintenanceDocument>> {
  const answer = await load(view, { id, kind: "maintenance" });
  if (answer.kind !== "maintenance" || !view) {
    throw mismatch();
  }
  return { document: answer.document, view };
}

/** A view's response headers: public, so the memo keeps it, and revalidated on every visit. */
export function publicHeaders(): Record<string, string> {
  return { "cache-control": publicPolicy };
}

const missingDataSchema = z.object({
  frame: viewFrameSchema,
  view: publicViewSchema.optional(),
});

/** What a view's not-found carries in its data; nothing when no page frames it. */
export function missingOf(data: unknown): MissingData | undefined {
  const parsed = missingDataSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A view's head: its title before the page's, the page's description as its
 * meta tags, the cover as the social image, the favicon, noindex, the
 * canonical address, each locale's alternate and the feed in the view's
 * locale, and the theme script before first paint. `suffix` is the view's own part of its address.
 */
export function viewHead(
  data: ViewData<{ readonly page: ViewFrame["page"] }> | undefined,
  suffix: string,
  title?: string
) {
  if (!data) {
    return {};
  }
  const { document, view } = data;
  const { page } = document;
  const absolute = (path: string) =>
    view.paths.origin ? `${view.paths.origin}${path}` : path;
  // The page's content in the view's locale, else the page language's.
  const text = (content: Content) =>
    contentIn(content, view.locale, page.locale);
  const heading = title ? `${title} · ${text(page.title)}` : text(page.title);
  const description = page.description && text(page.description);
  const meta = [
    { title: heading },
    { content: heading, property: "og:title" },
    ...(description
      ? [
          { content: description, name: "description" },
          { content: description, property: "og:description" },
        ]
      : []),
    ...(page.images.cover
      ? [
          { content: absolute(page.images.cover), property: "og:image" },
          { content: "summary_large_image", name: "twitter:card" },
        ]
      : []),
    ...(page.noindex ? [{ content: "noindex", name: "robots" }] : []),
  ];
  const links = [
    {
      href: absolute(viewPath(view.paths, view.locale, suffix)),
      rel: "canonical",
    },
    ...locales.map((locale) => ({
      href: absolute(viewPath(view.paths, locale, suffix)),
      hrefLang: locale,
      rel: "alternate",
    })),
    {
      href: feedUrl(view.paths, view.locale),
      rel: "alternate",
      title: text(page.title),
      type: "application/atom+xml",
    },
    ...faviconLinks(page.images.favicon),
  ];
  return {
    links,
    meta,
    scripts: [{ children: themeScript(page.theme) }],
  };
}

/** A not-found view's head: the page's title and favicon, never indexed, and the theme script. */
export function missingHead(error: unknown) {
  const missing = isNotFound(error) ? missingOf(error.data) : undefined;
  const frame = missing?.frame;
  if (!frame) {
    return {};
  }
  return {
    links: faviconLinks(frame.page.images.favicon),
    meta: [
      {
        title: contentIn(
          frame.page.title,
          missing?.view?.locale ?? frame.page.locale,
          frame.page.locale
        ),
      },
      { content: "noindex", name: "robots" },
    ],
    scripts: [{ children: themeScript(frame.page.theme) }],
  };
}

/** The history's head: the month by name before the page's title; its canonical address names the month, `/history` included. */
export function historyHead(
  data: ViewData<HistoryDocument> | undefined,
  error: unknown
) {
  return data
    ? viewHead(
        data,
        `/history/${data.document.month}`,
        formatMonth(
          data.view.locale,
          data.document.month,
          data.document.calendar
        )
      )
    : missingHead(error);
}

export function incidentHead(
  data: ViewData<IncidentDocument> | undefined,
  error: unknown
) {
  const incident = data?.document.incident;
  return data && incident
    ? viewHead(
        data,
        `/incidents/${encodeURIComponent(incident.id)}`,
        contentIn(incident.title, data.view.locale, data.document.page.locale)
      )
    : missingHead(error);
}

export function maintenanceHead(
  data: ViewData<MaintenanceDocument> | undefined,
  error: unknown
) {
  const window = data?.document.window;
  return data && window
    ? viewHead(
        data,
        `/maintenance/${encodeURIComponent(window.id)}`,
        contentIn(window.title, data.view.locale, data.document.page.locale)
      )
    : missingHead(error);
}

/** The overview's head, which the two overview routes write; a not-found's where no page is at the address. */
export function overviewHead(data: OverviewData | undefined, error: unknown) {
  return data ? viewHead(data, "") : missingHead(error);
}
