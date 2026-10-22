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
 * memo's, like an address no page has. A private page's answers are kept
 * like any page's and answered only to a request its page access lets in;
 * anyone else gets its access page, kept still, or a plain 403, and a form
 * POST at one of its views is a try at its page password. Any other request,
 * and every request while no database is open, is not its business, but for
 * a not-found: an address no route answers, or an incident, window or month a
 * page lacks, is answered with a not-found the app renders once per frame and
 * the memo keeps still, so a scanner's burst costs one render.
 */

import { verifyPassword } from "@/server/auth/password.ts";
import type { InstallKey } from "@/server/boot/installkey.ts";
import {
  clientAddressHeader,
  requestOriginHeader,
} from "@/server/boot/proxies.ts";
import { busyAnswer } from "@/server/pace.ts";
import {
  type AttemptLimiter,
  admits,
  createAttemptLimiter,
  issuePass,
  passCookie,
  passwordDigest,
} from "@/server/pages/access.ts";
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
import type { PageAccess } from "@/shared/schemas/page.ts";
import { type Month, monthSchema } from "@/shared/schemas/views.ts";
import { createMemo, memoCap } from "./memo.ts";
import { stillDocument, withAccessLine, withLocaleSwitch } from "./still.ts";

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
  /**
   * A visitor's try at a private page's password: a form POST, with
   * `password`, at any address of one of its views. Counted per client
   * network before anything is read; a POST from another origin is refused.
   * The right password answers 303 back to the address with a page pass;
   * a wrong one, or one past the client's share, the page's access page
   * saying so. Nothing for any other request.
   */
  readonly attempt: (
    request: Request,
    storage: PublicStorage | undefined,
    renderMissing: RenderMissing,
    /** Runs the password's verification as the entry paces it, one at a time for a stranger; nothing when no turn is free, which answers 503. Run at once without one. */
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

/** The access a page is judged by when storage cannot say what it is: open to a session alone, never a stranger. */
const closedAccess: PageAccess = {
  addresses: [],
  mode: "signed_in",
  passwordDigest: undefined,
};

/** The largest form a try at a page password may post. */
const attemptBodyBytes = 2048;

/** A private page's answer as it leaves: kept by no cache but the visitor's own, and never indexed; the memo's ETag, which a no-store answer has no use for, left out. */
function privately(
  response: Response,
  rewrite: {
    readonly "retry-after"?: string | undefined;
    readonly status?: number;
  } = {}
): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-robots-tag", "noindex");
  headers.delete("etag");
  if (rewrite["retry-after"] !== undefined) {
    headers.set("retry-after", rewrite["retry-after"]);
  }
  return new Response(response.body, {
    headers,
    status: rewrite.status ?? response.status,
  });
}

/** The answer to a private page's document, badge, feed or summary for a request without access. */
function forbidden(): Response {
  return privately(
    new Response("Forbidden", {
      headers: { "content-type": "text/plain; charset=utf-8" },
      status: 403,
    })
  );
}

/** A try's form, read only when it comes from the page's own origin and fits its small bound; else the refusal. */
async function tryBody(request: Request): Promise<string | Response> {
  const sent = request.headers.get("origin");
  // A form posted from another site is no visitor's own try.
  if (sent !== null && sent !== request.headers.get(requestOriginHeader)) {
    return forbidden();
  }
  if (Number(request.headers.get("content-length")) > attemptBodyBytes) {
    return tooLarge();
  }
  const body = await request.text();
  return body.length > attemptBodyBytes ? tooLarge() : body;
}

function tooLarge(): Response {
  return new Response("Payload Too Large", {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status: 413,
  });
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
  /** Counts the attempts at page passwords; ten per client network in ten minutes by default. */
  readonly attempts?: AttemptLimiter;
  /** Seals and opens page passes; with none no visitor holds one. */
  readonly key?: InstallKey;
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
  /** Whether a read at `counter` is newer than the index: the counter only moves up, so an older read that lands last never replaces a newer one. */
  const newer = (counter: number) =>
    indexedAt === undefined || counter > indexedAt;
  const read = async (storage: PublicStorage): Promise<number | undefined> => {
    try {
      const counter = await storage.changeCounter();
      if (newer(counter)) {
        const [pages, address] = await Promise.all([
          storage.pages.list(),
          readPublicAddress(storage),
        ]);
        if (newer(counter)) {
          index = publicIndexOf(pages, address);
          indexedAt = counter;
        }
      }
      return counter;
    } catch {
      // Nothing to judge an entry by: the page renders fresh, its access read again from storage.
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
  /** A target with its page's access and publication as storage holds them now; closed to all but a session when the page cannot be read; nothing when the page is gone. */
  const asStored = async <Target extends PublicTarget>(
    storage: PublicStorage,
    target: Target
  ): Promise<Target | undefined> => {
    try {
      const page = await storage.pages.find(target.pageId);
      return (
        page && { ...target, access: page.access, published: page.published }
      );
    } catch {
      return { ...target, access: closedAccess };
    }
  };
  /** Whether the request may see the target's page, by its page access. */
  const admitted = (request: Request, target: PublicTarget) =>
    admits(
      { access: target.access, id: target.pageId },
      {
        client: request.headers.get(clientAddressHeader) ?? undefined,
        cookie: request.headers.get("cookie"),
        signedIn: () => operator(request),
      },
      options.key,
      options.now()
    );
  /** A private view's access page in its locale, kept still per page, locale and host like a not-found, its language switch keeping the address; with `line`, the line that says why a try failed shown. Without the app's not-found render, a plain 403. */
  const accessPage = async (
    request: Request,
    target: ViewTarget,
    counter: number | undefined,
    renderMissing: RenderMissing | undefined,
    line?: "access-limited" | "access-wrong",
    /** For a client past its share: how long until its oldest try leaves the period. */
    retryAfterMs = 0
  ): Promise<Response> => {
    if (!renderMissing) {
      return forbidden();
    }
    const key = `access ${target.pageId} ${target.locale} ${target.paths.origin ?? ""}`;
    const overview = viewPath(target.paths, target.locale, "");
    const locked: ViewTarget = {
      ...target,
      key,
      locked: true,
      suffix: "",
      view: "overview",
    };
    const answer = await kept(request, key, counter, (refresh) =>
      renderMissing(bare(request, overview), locked, refresh)
    );
    // A render with no turn is answered as it came.
    if (answer.status !== 404) {
      return answer;
    }
    const other =
      locales.find((each) => each !== target.locale) ?? target.locale;
    const page = withLocaleSwitch(
      answer,
      viewPath(target.paths, other, target.suffix)
    );
    return privately(line ? withAccessLine(page, line) : page, {
      "retry-after":
        line === "access-limited"
          ? String(Math.ceil(retryAfterMs / 1000))
          : undefined,
      status: line === "access-limited" ? 429 : 403,
    });
  };
  /** A private page's answer to a request without access: a view's access page, else a plain 403. */
  const denied = async (
    request: Request,
    target: PublicTarget,
    counter: number | undefined,
    renderMissing: RenderMissing | undefined
  ): Promise<Response> =>
    target.kind === "view"
      ? await accessPage(request, target, counter, renderMissing)
      : forbidden();
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

  /** What a target shows: its render, or the page's not-found kept still for a view whose incident, window or month its page lacks. */
  const shownAt = async (
    request: Request,
    storage: PublicStorage,
    target: PublicTarget,
    counter: number | undefined,
    refresh: boolean,
    app: {
      readonly check: Check | undefined;
      readonly render: (
        target: PublicTarget,
        refresh: boolean
      ) => Promise<Response>;
      readonly renderMissing: RenderMissing | undefined;
    }
  ): Promise<Response> => {
    // Only an incident, a window or a month has a read of its own to check.
    if (
      !app.renderMissing ||
      target.kind !== "view" ||
      !itemPath.test(target.suffix)
    ) {
      return await app.render(target, refresh);
    }
    const itemRead = () => notOnPage(storage, target);
    const lacking = app.check ? await app.check(itemRead) : await itemRead();
    if (lacking === undefined) {
      return busyAnswer();
    }
    return lacking
      ? await viewNotFound(request, target, counter, app.renderMissing)
      : await app.render(target, refresh);
  };
  /** An unpublished page's view or document, the operator's preview alone: rendered fresh, kept by no one; nothing for anyone else, or for its badge, feed or summary. */
  const preview = async (
    request: Request,
    target: PublicTarget,
    render: (target: PublicTarget, refresh: boolean) => Promise<Response>
  ): Promise<Response | undefined> => {
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
  };
  const attempts = options.attempts ?? createAttemptLimiter();

  return {
    attempt: async (request, storage, renderMissing, check) => {
      if (!storage || request.method !== "POST") {
        return;
      }
      const counter = await read(storage);
      // The page password is read from storage below, so a stale index costs a try at most.
      const target = targetOf(request);
      if (
        target?.kind !== "view" ||
        !target.published ||
        target.access.mode !== "password"
      ) {
        return;
      }
      const body = await tryBody(request);
      if (body instanceof Response) {
        return body;
      }
      const now = options.now();
      const client = request.headers.get(clientAddressHeader) ?? undefined;
      // Counted before any read, so a flood from one client costs no hash. A client past its share is not judged at all, the right password included: judging it would answer a guess.
      if (!attempts.take(client, now)) {
        return await accessPage(
          request,
          target,
          counter,
          renderMissing,
          "access-limited",
          attempts.retryAfter(client, now)
        );
      }
      const typed = new URLSearchParams(body).get("password") ?? "";
      const hash = await storage.pages.password(target.pageId);
      const judge = () =>
        hash === undefined
          ? Promise.resolve(false)
          : verifyPassword({ hash, password: typed });
      const right = check ? await check(judge) : await judge();
      if (right === undefined) {
        return busyAnswer();
      }
      if (!(right && hash !== undefined && options.key)) {
        return await accessPage(
          request,
          target,
          counter,
          renderMissing,
          "access-wrong"
        );
      }
      // The right password costs the client none of its share.
      attempts.refund(client, now);
      const pass = await issuePass(
        options.key,
        {
          access: { ...target.access, passwordDigest: passwordDigest(hash) },
          id: target.pageId,
        },
        now
      );
      const url = new URL(request.url);
      return new Response(null, {
        headers: {
          "cache-control": "no-store",
          location: `${url.pathname}${url.search}`,
          "set-cookie": passCookie(
            target.pageId,
            pass,
            request.headers.get(requestOriginHeader)?.startsWith("https:") ??
              false
          ),
        },
        status: 303,
      });
    },
    answer: async (request, storage, render, counted, renderMissing, check) => {
      if (!storage || (request.method !== "GET" && request.method !== "HEAD")) {
        return;
      }
      const counter = await (counted ?? read(storage));
      const resolved = targetOf(request);
      // With no counter the pages last read vouch for nothing: the page's access is read again, closed when it cannot be.
      const target =
        resolved && counter === undefined
          ? await asStored(storage, resolved)
          : resolved;
      if (!target) {
        return;
      }
      if (!target.published) {
        return await preview(request, target, render);
      }
      const open = target.access.mode === "public";
      // A private page's answers, kept or not, go only to a request its access lets in.
      if (!(open || (await admitted(request, target)))) {
        return await denied(request, target, counter, renderMissing);
      }
      const shown = (refresh: boolean) =>
        shownAt(request, storage, target, counter, refresh, {
          check,
          render,
          renderMissing,
        });
      const answer =
        counter === undefined
          ? await shown(false)
          : await memo.respond(
              request,
              target.key,
              { counter, day: utcDayStart(options.now()) },
              shown
            );
      return open ? answer : privately(answer);
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
