/**
 * What a status page's badge, feed and summary routes share: each answers the page, locale and addresses the
 * entry resolved for the memo, so a route file that matches a path the
 * resolver refuses (a page's own language prefix, `/status/<slug>` on a
 * custom domain) answers not found. Not a route file: the leading dash
 * keeps it out of the route tree.
 */
import type { RequestContext } from "@/handler.ts";
import { badgeResponse, readBadge } from "@/server/pages/badge.ts";
import { feedResponse, readFeed } from "@/server/pages/feed.ts";
import { readSummary } from "@/server/pages/summary.ts";
import { viewResponse } from "@/server/pages/views.ts";

/** The answer to a GET or HEAD of a page's badge, feed or summary; a route's path and the resolver's always name the same one. */
export async function resourceAnswer(
  context: Pick<RequestContext, "publicTarget" | "storage">
): Promise<Response> {
  const { publicTarget: target, storage } = context;
  if (target?.kind !== "resource") {
    return viewResponse({ ok: false, reason: "not_found" });
  }
  const { locale, pageId, paths, resource } = target;
  switch (resource) {
    case "badge":
      return badgeResponse(
        storage && (await readBadge(storage, pageId, locale))
      );
    case "feed":
      return feedResponse(
        storage && (await readFeed(storage, pageId, locale, paths))
      );
    case "summary":
      return viewResponse(
        storage && (await readSummary(storage, pageId, paths))
      );
    default:
      return resource satisfies never;
  }
}

/** A view's document answered only where the entry resolved one: an unpublished page's resolves for the signed-in operator alone, so anyone else is not found, whatever the page id. */
export async function documentAnswer(
  context: Pick<RequestContext, "publicTarget">,
  answer: () => Promise<Response>
): Promise<Response> {
  return context.publicTarget?.kind === "document"
    ? await answer()
    : viewResponse({ ok: false, reason: "not_found" });
}
