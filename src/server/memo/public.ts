/**
 * The memo in front of the public page: how the
 * entry learns which page and locale a request shows before anything
 * renders. It reads the change counter once per public request, reads the
 * pages again only when the counter moved, resolves the request's host and
 * path to a view, a view's document, or a page's summary, badge or feed,
 * and answers it from the memo with
 * the counter and the UTC day as the entry's validity. An unpublished
 * page's view or document is answered to the signed-in operator alone,
 * rendered outside the memo and never cached; to anyone else it is not the
 * memo's, like an address no page has. Any other request,
 * and every request while no database is open, is not its business, but for
 * a not-found: an address no route answers, or an incident, window or month a
 * page lacks, is answered with a not-found the app renders once per frame and
 * the memo keeps still, so a scanner's burst costs one render.
 */

import { requestOriginHeader } from "@/server/boot/proxies.ts";
import {
  missingAddress,
  missingView,
  type PublicIndex,
  type PublicTarget,
  publicIndexOf,
  publicTarget,
  unresolvedAt,
  type ViewTarget,
} from "@/server/pages/public.ts";
import {
  apiNotFound,
  readHistory,
  readIncidentView,
  readMaintenanceView,
  type ViewResult,
  type ViewStorage,
} from "@/server/pages/views.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { historyMonth, monthOf } from "@/shared/domain/history.ts";
import { utcDayStart } from "@/shared/domain/retention.ts";
import { locales } from "@/shared/i18n/locale.ts";
import { type PublicView, viewPath } from "@/shared/schemas/overview.ts";
import { monthSchema } from "@/shared/schemas/views.ts";
import { createMemo, memoCap } from "./memo.ts";
import { stillDocument, withLocaleSwitch } from "./still.ts";

export type PublicStorage = Pick<Storage, "changeCounter"> & ViewStorage;

/** Renders a page's not-found through the app at `address`, with the view target it shows or none, its stylesheet linked rather than inlined: the memo keeps the document still and serves it at every address of the same frame. */
export type RenderMissing = (
  address: Request,
  target: ViewTarget | undefined
) => Promise<Response>;

export interface PublicMemo {
  /**
   * The memoised answer to a GET or HEAD that shows a view, a view's
   * document, or a page's summary, badge or feed, rendering it through `render` with the target resolved;
   * nothing for any other request, which the entry hands on unchanged.
   */
  readonly answer: (
    request: Request,
    storage: PublicStorage | undefined,
    render: (target: PublicTarget) => Promise<Response>,
    /** The counter this request already read through `read`, so it reads it once; read here when absent. */
    counter?: Promise<number | undefined>,
    /** How a view whose incident, window or month is not on its page renders its not-found, which the memo then keeps still; without one the view renders it every time. */
    renderMissing?: RenderMissing
  ) => Promise<Response | undefined>;
  /** The page whose frame shows a not-found at the request's address, from the pages the last answer read: no database read of its own, so a scanner's address costs none. */
  readonly missing: (request: Request) => PublicView | undefined;
  /**
   * The not-found at an address no page's view resolves and no app route
   * answers: the API's own under `/api/`, else the page's, framed by the page
   * the address or host names, rendered through `renderMissing` once per frame
   * while the change counter and the UTC day hold and served still at every
   * such address. Nothing for an address the app's own route answers, unless
   * `gone` says that route answers a not-found there: then the plain one,
   * rendered once at that address.
   */
  readonly notFound: (
    request: Request,
    storage: PublicStorage | undefined,
    renderMissing: RenderMissing,
    counter?: Promise<number | undefined>,
    gone?: (pathname: string) => Promise<boolean>
  ) => Promise<Response | undefined>;
  /** The public address the pages index was last read with; current after any GET or HEAD over an open database, since each reads the change counter first. */
  readonly publicAddress: () => string | undefined;
  /** Reads the change counter and, when it moved, the pages index again; the counter, or nothing when it could not be read. The entry reads it once per GET or HEAD, before the request's client address is resolved. */
  readonly read: (storage: PublicStorage) => Promise<number | undefined>;
  /** How many responses the memo keeps. */
  readonly size: () => number;
  /** Whether the request's address is an unpublished page's, which a visitor finds nothing at: the bare host then answers not found rather than sending to the admin. From the pages the last answer read. */
  readonly unpublished: (request: Request) => boolean;
}

/** The host the entry resolved behind the trusted proxies, from its own header; nothing when it resolved none. */
function resolvedHost(request: Request): string | undefined {
  const origin = request.headers.get(requestOriginHeader);
  if (origin === null) {
    return;
  }
  try {
    return new URL(origin).hostname;
  } catch {
    // The entry writes an origin it parsed, so this is only a request from elsewhere.
    return undefined;
  }
}

/** The counter a not-found is judged by while no database is open: never one a database reads, so the first read after onboarding opens one renders it again. */
const noDatabase = -1;

/** The request the app renders a not-found for: the address and the origin the entry resolved alone, so no visitor's cookie shapes the document every visitor gets. */
function bare(request: Request, path: string): Request {
  const origin = request.headers.get(requestOriginHeader);
  return new Request(new URL(path, request.url), {
    headers: origin === null ? {} : { [requestOriginHeader]: origin },
  });
}

/** A view's own part that names an incident, a window or a month. */
const itemPath = /^\/(incidents|maintenance|history)\/([^/]+)$/;

/** Whether a view read answered that nothing is at the address. */
const nothingAt = (read: ViewResult<unknown>) =>
  !read.ok && read.reason === "not_found";

/**
 * Whether the page lacks the incident, window or month `kind` names, as its
 * view would read it. The cheap answer comes first, so a burst of made-up
 * ids costs one row read each: no such incident or window, a month after this
 * one, or one inside the history every page shows.
 */
async function lacks(
  storage: PublicStorage,
  pageId: string,
  kind: string | undefined,
  item: string,
  now: number
): Promise<boolean> {
  switch (kind) {
    case "incidents":
      return (
        (await storage.incidents.find(item)) === undefined ||
        nothingAt(await readIncidentView(storage, pageId, item))
      );
    case "maintenance":
      return (
        (await storage.maintenance.find(item)) === undefined ||
        nothingAt(await readMaintenanceView(storage, pageId, item))
      );
    case "history": {
      const month = monthSchema.safeParse(item);
      if (!month.success || historyMonth([], month.data, now)) {
        return false;
      }
      return (
        month.data > monthOf(now) ||
        nothingAt(await readHistory(storage, pageId, month.data, now))
      );
    }
    default:
      return false;
  }
}

/** The public memo over the clock the UTC day is read from. `operator` tells whether a request carries the operator's session, which alone sees an unpublished page's views and documents, rendered outside the memo; with none, no one does. */
export function createPublicMemo(options: {
  readonly now: () => number;
  readonly operator?: (request: Request) => Promise<boolean>;
}): PublicMemo {
  let index: PublicIndex = { pages: [], publicAddress: undefined };
  /** The change counter the index was read at; a move means a page or the public address may have changed. */
  let indexedAt: number | undefined;
  const memo = createMemo(() => memoCap(index.pages.length));
  const operator = options.operator ?? (() => Promise.resolve(false));
  const targetOf = (request: Request) =>
    publicTarget(index, resolvedHost(request), new URL(request.url).pathname);
  const read = async (storage: PublicStorage): Promise<number | undefined> => {
    try {
      const counter = await storage.changeCounter();
      if (counter !== indexedAt) {
        const [pages, address] = await Promise.all([
          storage.pages.list(),
          readPublicAddress(storage),
        ]);
        index = publicIndexOf(pages, address);
        indexedAt = counter;
      }
      return counter;
    } catch {
      // Nothing to judge an entry by: the page renders fresh from the pages last read.
      return undefined;
    }
  };
  // One still not-found per frame, kept as long as the pages' own entries are.
  const missingDocuments = createMemo(
    () => memoCap(index.pages.length),
    (response) => response.status === 404
  );
  /** A not-found kept still under `key` while the counter and the UTC day hold; rendered fresh when the counter could not be read. */
  const kept = async (
    request: Request,
    key: string,
    counter: number | undefined,
    render: () => Promise<Response>
  ): Promise<Response> => {
    const still = async () => stillDocument(await render());
    if (counter === undefined) {
      return await still();
    }
    const validity = { counter, day: utcDayStart(options.now()) };
    return await missingDocuments.respond(request, key, validity, still);
  };
  /** The not-found at an address that names no view: framed by the page the address or host names, rendered at the address that frame renders at. */
  const pageNotFound = (
    request: Request,
    counter: number | undefined,
    renderMissing: RenderMissing
  ): Promise<Response> => {
    const frame = missingView(
      index,
      resolvedHost(request),
      new URL(request.url).pathname
    );
    const key = frame
      ? `missing ${frame.pageId} ${frame.paths.origin ?? ""}`
      : "missing";
    return kept(request, key, counter, () =>
      renderMissing(bare(request, missingAddress(frame)), undefined)
    );
  };
  /** A view's not-found in its locale, its language switch keeping the address. */
  const viewNotFound = async (
    request: Request,
    target: ViewTarget,
    counter: number | undefined,
    renderMissing: RenderMissing
  ): Promise<Response> => {
    const key = `missing ${target.pageId} ${target.locale} ${target.paths.origin ?? ""}`;
    const answer = await kept(request, key, counter, () =>
      renderMissing(bare(request, new URL(request.url).pathname), target)
    );
    const other =
      locales.find((each) => each !== target.locale) ?? target.locale;
    return withLocaleSwitch(
      answer,
      viewPath(target.paths, other, target.suffix)
    );
  };
  /** Whether the incident, window or month a view's address names is one its page lacks, read as the view would read it; an address that cannot be read is the view's to answer. */
  const notOnPage = async (
    storage: PublicStorage,
    target: ViewTarget
  ): Promise<boolean> => {
    const [, kind, raw = ""] = itemPath.exec(target.suffix) ?? [];
    try {
      return await lacks(
        storage,
        target.pageId,
        kind,
        decodeURIComponent(raw),
        options.now()
      );
    } catch {
      // A malformed escape or a database that did not answer: the view answers it as it always has.
      return false;
    }
  };

  return {
    answer: async (request, storage, render, counted, renderMissing) => {
      if (!storage || (request.method !== "GET" && request.method !== "HEAD")) {
        return;
      }
      const counter = await (counted ?? read(storage));
      const target = targetOf(request);
      if (!target) {
        return;
      }
      if (!target.published) {
        // The operator's preview alone, of a view or its document: rendered fresh, kept by no one.
        if (target.kind === "resource" || !(await operator(request))) {
          return;
        }
        const rendered = await render(target);
        const headers = new Headers(rendered.headers);
        headers.set("cache-control", "no-store");
        return new Response(rendered.body, {
          headers,
          status: rendered.status,
        });
      }
      // A view whose incident, window or month its page lacks is the page's not-found, kept still.
      const shown = async () =>
        renderMissing &&
        target.kind === "view" &&
        (await notOnPage(storage, target))
          ? await viewNotFound(request, target, counter, renderMissing)
          : await render(target);
      if (counter === undefined) {
        return await shown();
      }
      const validity = { counter, day: utcDayStart(options.now()) };
      return await memo.respond(request, target.key, validity, shown);
    },
    notFound: async (request, storage, renderMissing, counted, gone) => {
      const counter = storage ? await (counted ?? read(storage)) : noDatabase;
      const target = storage ? targetOf(request) : undefined;
      if (target) {
        // A published page's address is its own route's; an unpublished page's view is a visitor's not-found.
        return target.published || target.kind !== "view"
          ? undefined
          : await pageNotFound(request, counter, renderMissing);
      }
      const { pathname } = new URL(request.url);
      switch (unresolvedAt(pathname)) {
        case "route":
          // The route's own not-found has no frame: rendered at its address, the same for every address it answers.
          return (await gone?.(pathname))
            ? await kept(request, "missing plain", counter, () =>
                renderMissing(bare(request, pathname), undefined)
              )
            : undefined;
        case "api":
          return apiNotFound();
        default:
          return await pageNotFound(request, counter, renderMissing);
      }
    },
    missing: (request) =>
      missingView(index, resolvedHost(request), new URL(request.url).pathname),
    publicAddress: () => index.publicAddress,
    read,
    size: memo.size,
    unpublished: (request) => targetOf(request)?.published === false,
  };
}
