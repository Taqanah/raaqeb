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
 * and every request while no database is open, is not its business.
 */

import { requestOriginHeader } from "@/server/boot/proxies.ts";
import {
  missingView,
  type PublicIndex,
  type PublicTarget,
  publicIndexOf,
  publicTarget,
} from "@/server/pages/public.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { utcDayStart } from "@/shared/domain/retention.ts";
import type { PublicView } from "@/shared/schemas/overview.ts";
import { createMemo, memoCap } from "./memo.ts";

export type PublicStorage = Pick<
  Storage,
  "changeCounter" | "pages" | "settings"
>;

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
    counter?: Promise<number | undefined>
  ) => Promise<Response | undefined>;
  /** The page whose frame shows a not-found at the request's address, from the pages the last answer read: no database read of its own, so a scanner's address costs none. */
  readonly missing: (request: Request) => PublicView | undefined;
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

  return {
    answer: async (request, storage, render, counted) => {
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
      if (counter === undefined) {
        return await render(target);
      }
      const validity = { counter, day: utcDayStart(options.now()) };
      return await memo.respond(request, target.key, validity, () =>
        render(target)
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
