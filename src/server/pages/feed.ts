/**
 * A status page's feed (CONTEXT.md "Feed"):
 * Atom, one entry for each incident and each maintenance window on the
 * page's components, the most recently changed first, each linking to its
 * view and holding its updates. The words are the address's locale, and so
 * is the content where the operator wrote it, else the page language's, each paragraph in its
 * own direction. Anyone may read it; it keeps no record. Reads never throw.
 */

import { readClock } from "@/server/settings/clock.ts";
import { loadCatalog } from "@/server/settings/language.ts";
import { affectedComponents } from "@/shared/domain/incidents.ts";
import { formatDateTimeWithZone, intlLocale } from "@/shared/i18n/format.ts";
import { directionOf, type Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { type Content, contentIn } from "@/shared/schemas/content.ts";
import {
  type PagePaths,
  resourceSuffixes,
  viewPath,
} from "@/shared/schemas/overview.ts";
import { componentsOf } from "@/shared/schemas/page.ts";
import {
  publicResponse,
  type ViewResult,
  type ViewStorage,
  xmlText,
} from "./views.ts";

export type FeedStorage = ViewStorage;

/** The most entries a feed holds: the ones changed last. */
export const feedEntries = 50;

const iso = (ms: number) => new Date(ms).toISOString();
const blankLine = /\n\s*\n/;

/** Plain text as XHTML paragraphs, each finding its own direction, a single newline kept as a break. */
function paragraphs(text: string): string[] {
  return text
    .split(blankLine)
    .filter((paragraph) => paragraph.trim() !== "")
    .map(
      (paragraph) =>
        `<p dir="auto">${paragraph.split("\n").map(xmlText).join("<br/>")}</p>`
    );
}

/** A label and its value on one line; both are already XML. */
const line = (label: string, value: string) =>
  `<p><strong>${label}</strong> ${value}</p>`;

interface Entry {
  readonly updated: number;
  readonly xml: string;
}

/** The feed of the page with that id, in `locale`, its links hanging from `paths`, as Atom text. */
export async function readFeed(
  storage: FeedStorage,
  pageId: string,
  locale: Locale,
  paths: PagePaths
): Promise<ViewResult<string>> {
  try {
    const page = await storage.pages.find(pageId);
    if (!page) {
      return { frame: undefined, ok: false, reason: "not_found" };
    }
    const [layout, components, incidents, windows, time, catalog] =
      await Promise.all([
        storage.pages.layout(pageId),
        storage.components.list(),
        storage.incidents.list(),
        storage.maintenance.list(),
        readClock(storage),
        loadCatalog(locale),
      ]);
    const messages = createMessages(locale, catalog);
    const t = (
      id: Parameters<typeof messages._>[0],
      values?: Parameters<typeof messages._>[1]
    ) => xmlText(messages._(id, values));
    // Each piece of content in the feed's locale, else the page language's.
    const text = (content: Content) => contentIn(content, locale, page.locale);
    const names = new Map(components.map((each) => [each.id, text(each.name)]));
    // A deleted component has left the layout with its row.
    const shown = componentsOf(layout).filter((id) => names.has(id));
    const list = new Intl.ListFormat(intlLocale(locale));
    /** The page's components among `ids`, in its order, as one line; nothing when none. */
    const affected = (ids: readonly string[]) => {
      const named = shown
        .filter((id) => ids.includes(id))
        .map((id) => names.get(id) ?? "");
      return named.length === 0
        ? undefined
        : line(t("public_affected"), xmlText(list.format(named)));
    };
    const address = (suffix: string) => {
      const path = viewPath(paths, locale, suffix);
      return paths.origin ? `${paths.origin}${path}` : path;
    };
    // A feed is a machine surface, so its dates stay Gregorian.
    const when = (ms: number) =>
      `<time datetime="${iso(ms)}">${xmlText(formatDateTimeWithZone(locale, ms, { ...time, calendar: "gregorian" }))}</time>`;
    const entry = (fields: {
      readonly category: "incident" | "maintenance";
      readonly content: readonly string[];
      readonly id: string;
      readonly link: string;
      readonly published: number;
      readonly title: string;
      readonly updated: number;
    }): Entry => ({
      updated: fields.updated,
      xml: [
        "<entry>",
        `<id>urn:uuid:${xmlText(fields.id)}</id>`,
        `<title>${xmlText(fields.title)}</title>`,
        `<link rel="alternate" type="text/html" href="${xmlText(address(fields.link))}"/>`,
        `<published>${iso(fields.published)}</published>`,
        `<updated>${iso(fields.updated)}</updated>`,
        `<category term="${fields.category}"/>`,
        `<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml" dir="${directionOf(locale)}">${fields.content.join("")}</div></content>`,
        "</entry>",
      ].join(""),
    });
    const entries: Entry[] = [];
    for (const incident of incidents) {
      const touched = affected(affectedComponents(incident));
      if (!touched) {
        continue;
      }
      entries.push(
        entry({
          category: "incident",
          content: [
            `<p>${t("public_impact", { impact: messages._(`incident_impact_${incident.impact}`) })}</p>`,
            touched,
            ...incident.updates
              .toReversed()
              .flatMap((update) => [
                line(
                  t(`incident_stage_${update.stage}`),
                  when(update.createdAt)
                ),
                ...paragraphs(text(update.message)),
              ]),
          ],
          id: incident.id,
          link: `/incidents/${encodeURIComponent(incident.id)}`,
          published: incident.createdAt,
          title: text(incident.title),
          updated: incident.updatedAt,
        })
      );
    }
    for (const window of windows) {
      const touched = affected(window.componentIds);
      if (!touched) {
        continue;
      }
      // Times read in the tense of the window's stage, as on its view.
      const started = window.stage !== "scheduled";
      const ended = window.stage === "completed";
      entries.push(
        entry({
          category: "maintenance",
          content: [
            `<p><strong>${t(`maintenance_stage_${window.stage}`)}</strong></p>`,
            line(
              t(
                started
                  ? "public_maintenance_started"
                  : "public_maintenance_starts"
              ),
              when(window.startsAt)
            ),
            line(
              t(ended ? "public_maintenance_ended" : "public_maintenance_ends"),
              when(window.endsAt)
            ),
            touched,
            ...paragraphs(text(window.message)),
          ],
          id: window.id,
          link: `/maintenance/${encodeURIComponent(window.id)}`,
          published: window.createdAt,
          title: text(window.title),
          updated: window.updatedAt,
        })
      );
    }
    const held = entries
      .toSorted((a, b) => b.updated - a.updated)
      .slice(0, feedEntries);
    const { description } = page.customization;
    return {
      document: [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${locale}">`,
        // One feed per page and locale, whatever address it is read at.
        `<id>urn:uuid:${Bun.randomUUIDv5(`feed ${locale}`, page.id)}</id>`,
        `<title>${xmlText(text(page.title))}</title>`,
        description ? `<subtitle>${xmlText(text(description))}</subtitle>` : "",
        `<updated>${iso(held[0]?.updated ?? page.updatedAt)}</updated>`,
        `<author><name>${xmlText(text(page.title))}</name></author>`,
        `<link rel="self" type="application/atom+xml" href="${xmlText(address(resourceSuffixes.feed))}"/>`,
        `<link rel="alternate" type="text/html" href="${xmlText(address(""))}"/>`,
        ...held.map((each) => each.xml),
        "</feed>",
      ].join(""),
      ok: true,
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** The feed's public answer: Atom with `Cache-Control: public`, 404 for no such page, 503 with no database. */
export function feedResponse(result: ViewResult<string> | undefined): Response {
  return publicResponse(
    result,
    "application/atom+xml; charset=utf-8",
    (feed) => feed
  );
}
