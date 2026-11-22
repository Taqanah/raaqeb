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
import { busyAnswer } from "@/server/pace.ts";
import {
  anonymousPageKey,
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
  readHistoryFirst,
  readIncidentView,
  readMaintenanceView,
  type ViewResult,
  type ViewStorage,
} from "@/server/pages/views.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { historyMonth, monthOf } from "@/shared/domain/history.ts";
import { utcDayStart } from "@/shared/domain/retention.ts";
import { locales, pathLocale } from "@/shared/i18n/locale.ts";
import { type PublicView, viewPath } from "@/shared/schemas/overview.ts";
import { type Month, monthSchema } from "@/shared/schemas/views.ts";
import { createMemo, memoCap } from "./memo.ts";
import { stillDocument, withLocaleSwitch } from "./still.ts";

export type PublicStorage = Pick<Storage, "changeCounter"> & ViewStorage;

/** Runs the read that checks an item at the pace the entry gives this request; nothing when no turn is free. */
export type Check = (
  read: () => Promise<boolean>
) => Promise<boolean | undefined>;

/** Renders a page's not-found through the app at `address`, with the view target it shows or none, its stylesheet linked rather than inlined: the memo keeps the document still and serves it at every address of the same frame. */
export type RenderMissing = (
  address: Request,
  target: ViewTarget | undefined,
  /** Whether the memo held this not-found and it went stale, else it holds none for its frame. */
  refresh: boolean
) => Promise<Response>;

export interface PublicMemo {
  /**
   * A page the app renders the same for everyone, signed in or not and on any
   * host (sign-in, forgot-password, sign-out, a reset page with no link,
   * onboarding's language and database screens), answered from memory for a
   * GET or HEAD by its address and `?locale=` alone, while the change counter
   * and the UTC day hold; rendered through `render` once. Nothing for any
   * other request.
   */
  readonly anonymous: (
    request: Request,
    storage: PublicStorage | undefined,
    /** Renders the page at `address`: its path and search alone, no cookie and no origin, since the page reads neither. */
    render: (address: Request, refresh: boolean) => Promise<Response>,
    counter?: Promise<number | undefined>
  ) => Promise<Response | undefined>;
  /**
   * The memoised answer to a GET or HEAD that shows a view, a view's
   * document, or a page's summary, badge or feed, rendering it through `render` with the target resolved;
   * nothing for any other request, which the entry hands on unchanged.
   */
  readonly answer: (
    request: Request,
    storage: PublicStorage | undefined,
    /** Renders the target; `refresh` says whether the memo held its entry and it went stale, else it holds none for the address. */
    render: (target: PublicTarget, refresh: boolean) => Promise<Response>,
    /** The counter this request already read through `read`, so it reads it once; read here when absent. */
    counter?: Promise<number | undefined>,
    /** How a view whose incident, window or month is not on its page renders its not-found, which the memo then keeps still; without one the view renders it every time. */
    renderMissing?: RenderMissing,
    /** Runs the read that tells whether the incident, window or month is on the page, as the entry paces it (a stranger's takes its turn); nothing when no turn is free, which answers 503. Run at once without one. */
    check?: Check
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

/** The anonymous pages kept at once: six pages in three spellings of their locale. */
const anonymousCap = 18;

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
  now: number,
  first: () => Promise<Month | undefined>
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
      // Before the history's first month, read once per change counter for every month asked.
      return month.data > monthOf(now) || month.data < ((await first()) ?? "");
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
  // The anonymous pages: a 200 that sets no cookie, whatever its cache policy, since none is public.
  const anonymousDocuments = createMemo(
    () => anonymousCap,
    (response) => response.status === 200 && !response.headers.has("set-cookie")
  );
  const missingDocuments = createMemo(
    () => memoCap(index.pages.length),
    (response) => response.status === 404
  );
  /** A not-found kept still under `key` while the counter and the UTC day hold; rendered fresh when the counter could not be read. */
  const kept = async (
    request: Request,
    key: string,
    counter: number | undefined,
    render: (refresh: boolean) => Promise<Response>
  ): Promise<Response> => {
    const still = async (refresh: boolean) =>
      stillDocument(await render(refresh));
    if (counter === undefined) {
      return await still(false);
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
    const { pathname } = new URL(request.url);
    const frame = missingView(index, resolvedHost(request), pathname);
    // A locale's prefix makes the document that locale's own.
    const locale = pathLocale(pathname);
    const key = `${frame ? `missing ${frame.pageId} ${frame.paths.origin ?? ""}` : "missing"} ${locale ?? ""}`;
    return kept(request, key, counter, (refresh) =>
      renderMissing(
        bare(request, missingAddress(frame, locale)),
        undefined,
        refresh
      )
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
    const answer = await kept(request, key, counter, (refresh) =>
      renderMissing(
        bare(request, new URL(request.url).pathname),
        target,
        refresh
      )
    );
    const other =
      locales.find((each) => each !== target.locale) ?? target.locale;
    return withLocaleSwitch(
      answer,
      viewPath(target.paths, other, target.suffix)
    );
  };
  /** Whether the incident, window or month a view's address names is one its page lacks, read as the view would read it; an address that cannot be read is the view's to answer. */
  // Each page's first history month, as of the change counter the index was read at.
  const firsts = new Map<
    string,
    {
      readonly at: number | undefined;
      readonly first: Promise<Month | undefined>;
    }
  >();
  const firstMonth = (
    storage: PublicStorage,
    pageId: string
  ): Promise<Month | undefined> => {
    const held = firsts.get(pageId);
    if (held && held.at === indexedAt) {
      return held.first;
    }
    const first = readHistoryFirst(storage, pageId, options.now()).then(
      (found) => (found.ok ? found.document : undefined)
    );
    firsts.set(pageId, { at: indexedAt, first });
    return first;
  };
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
        options.now(),
        () => firstMonth(storage, target.pageId)
      );
    } catch {
      // A malformed escape or a database that did not answer: the view answers it as it always has.
      return false;
    }
  };

  return {
    answer: async (request, storage, render, counted, renderMissing, check) => {
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
        const rendered = await render(target, false);
        const headers = new Headers(rendered.headers);
        headers.set("cache-control", "no-store");
        return new Response(rendered.body, {
          headers,
          status: rendered.status,
        });
      }
      // A view whose incident, window or month its page lacks is the page's not-found, kept still.
      const shown = async (refresh: boolean): Promise<Response> => {
        // Only an incident, a window or a month has a read of its own to check.
        if (
          !renderMissing ||
          target.kind !== "view" ||
          !itemPath.test(target.suffix)
        ) {
          return await render(target, refresh);
        }
        const itemRead = () => notOnPage(storage, target);
        const lacking = check ? await check(itemRead) : await itemRead();
        if (lacking === undefined) {
          return busyAnswer();
        }
        return lacking
          ? await viewNotFound(request, target, counter, renderMissing)
          : await render(target, refresh);
      };
      if (counter === undefined) {
        return await shown(false);
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
            ? await kept(request, "missing plain", counter, (refresh) =>
                renderMissing(bare(request, pathname), undefined, refresh)
              )
            : undefined;
        case "api":
          return apiNotFound();
        default:
          return await pageNotFound(request, counter, renderMissing);
      }
    },
    anonymous: async (request, storage, render, counted) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return;
      }
      const url = new URL(request.url);
      const page = anonymousPageKey(url.pathname, url.search);
      if (page === undefined) {
        return;
      }
      const counter = storage ? await (counted ?? read(storage)) : noDatabase;
      // Nothing to judge an entry by: the page renders as any other does.
      if (counter === undefined) {
        return;
      }
      const validity = { counter, day: utcDayStart(options.now()) };
      // The page reads neither a cookie nor the host: rendered at its path and search alone, it is every visitor's.
      return await anonymousDocuments.respond(
        request,
        page,
        validity,
        (refresh) =>
          render(
            new Request(new URL(`${url.pathname}${url.search}`, url)),
            refresh
          )
      );
    },
    missing: (request) =>
      missingView(index, resolvedHost(request), new URL(request.url).pathname),
    publicAddress: () => index.publicAddress,
    read,
    size: memo.size,
    unpublished: (request) => targetOf(request)?.published === false,
  };
}
