/**
 * The JSON documents of a status page's history, incident and maintenance
 * views (ADR-0006). Each carries the
 * page's frame beside what the view shows. An incident or a window is on a
 * page while it affects a component the page shows; the history lists the
 * page's resolved incidents and completed windows by the UTC month they
 * started in. The route loader calls these while the server renders a view,
 * and the document routes answer the same values as JSON, so the HTML and
 * the API cannot disagree. Reads never throw.
 */

import { readClock } from "@/server/settings/clock.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { historyMonth, monthOf } from "@/shared/domain/history.ts";
import {
  affectedComponents,
  incidentStage,
} from "@/shared/domain/incidents.ts";
import { type OverviewPage, publicPolicy } from "@/shared/schemas/overview.ts";
import {
  componentsOf,
  type PageImage,
  pageImageUrl,
  type StatusPage,
} from "@/shared/schemas/page.ts";
import type {
  HistoryDocument,
  HistoryEntry,
  IncidentDocument,
  MaintenanceDocument,
  Month,
  ViewComponent,
  ViewFrame,
} from "@/shared/schemas/views.ts";

export type ViewStorage = Pick<
  Storage,
  "components" | "incidents" | "maintenance" | "pages" | "settings"
>;

/**
 * A view's document, or why there is none. A page that exists with nothing
 * at the address (an incident or window not on it, a month outside its
 * history) answers `not_found` with the page's frame, so the view can say
 * so inside the page; an unknown page answers it
 * with none.
 */
export type ViewResult<Document> =
  | { readonly document: Document; readonly ok: true }
  | {
      readonly frame?: ViewFrame;
      readonly ok: false;
      readonly reason: "not_found";
    }
  | { readonly ok: false; readonly reason: "unavailable" };

const unavailable = { ok: false, reason: "unavailable" } as const;
const iso = (ms: number) => new Date(ms).toISOString();

/** What every view shows of the page: its text, its images' URLs and its customization. */
export function pageOf(
  page: StatusPage,
  images: readonly PageImage[]
): OverviewPage {
  const { customization } = page;
  const urls = Object.fromEntries(
    images.map((image) => [image.kind, pageImageUrl(page.id, image)])
  );
  return {
    brandColour: customization.brandColour,
    contactUrl: customization.contactUrl,
    customCss: customization.customCss,
    description: customization.description,
    footerLinks: customization.footerLinks,
    id: page.id,
    images: { cover: urls.cover, favicon: urls.favicon, logo: urls.logo },
    labels: customization.labels,
    locale: page.locale,
    noindex: customization.noindex,
    poweredBy: customization.poweredBy,
    statusColours: customization.statusColours,
    theme: customization.theme,
    title: page.title,
  };
}

/** A page's frame and the components it shows, in its order, by name. */
interface PageRead {
  readonly frame: ViewFrame;
  /** The components the page shows, in its order, with their names. */
  readonly named: (ids: readonly string[]) => ViewComponent[];
  /** Whether the page is published. */
  readonly published: boolean;
}

/** The page's frame and its components, or nothing for an unknown page. */
async function pageRead(
  storage: ViewStorage,
  pageId: string
): Promise<PageRead | undefined> {
  const page = await storage.pages.find(pageId);
  if (!page) {
    return;
  }
  const [images, time, layout, components] = await Promise.all([
    storage.pages.images(pageId),
    readClock(storage),
    storage.pages.layout(pageId),
    storage.components.list(),
  ]);
  const names = new Map(components.map((each) => [each.id, each.name]));
  // A deleted component has left the layout with its row.
  const shown = componentsOf(layout).flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [{ id, name }];
  });
  return {
    frame: {
      calendar: time.calendar,
      clock: time.clock,
      page: pageOf(page, images),
      timeZone: time.timeZone,
    },
    named: (ids) => shown.filter((each) => ids.includes(each.id)),
    published: page.published,
  };
}

/** Reads a page and hands it to `view`, which answers the document or nothing when nothing is at the address; never throws. */
async function readView<Document>(
  storage: ViewStorage,
  pageId: string,
  view: (read: PageRead) => Promise<Document | undefined>
): Promise<ViewResult<Document>> {
  try {
    const read = await pageRead(storage, pageId);
    if (!read) {
      return { frame: undefined, ok: false, reason: "not_found" };
    }
    const document = await view(read);
    return document === undefined
      ? { frame: read.frame, ok: false, reason: "not_found" }
      : { document, ok: true };
  } catch {
    return unavailable;
  }
}

/** The page's frame alone: its text, images, customization and the install's calendar and clock; nothing for an unknown page. */
export function readViewFrame(
  storage: ViewStorage,
  pageId: string
): Promise<ViewResult<ViewFrame>> {
  return readView(storage, pageId, ({ frame, published }) =>
    Promise.resolve(
      published
        ? frame
        : // A visitor's request for an unpublished page's image is not found, so its frame names none.
          {
            ...frame,
            page: {
              ...frame.page,
              images: { cover: undefined, favicon: undefined, logo: undefined },
            },
          }
    )
  );
}

/** The page's history for a month, the current one when none is named. */
export function readHistory(
  storage: ViewStorage,
  pageId: string,
  month: Month | undefined,
  now: number
): Promise<ViewResult<HistoryDocument>> {
  return readView(storage, pageId, async ({ frame, named }) => {
    // ponytail: reads every incident and window, as the admin lists do; a range read when an install holds years of them.
    const [incidents, windows] = await Promise.all([
      storage.incidents.list(),
      storage.maintenance.list(),
    ]);
    const entries: { readonly entry: HistoryEntry; readonly start: number }[] =
      [];
    for (const incident of incidents) {
      const components = named(affectedComponents(incident));
      if (incident.resolvedAt !== undefined && components.length > 0) {
        entries.push({
          entry: {
            components,
            id: incident.id,
            impact: incident.impact,
            kind: "incident",
            resolvedAt: iso(incident.resolvedAt),
            startedAt: iso(incident.createdAt),
            title: incident.title,
          },
          start: incident.createdAt,
        });
      }
    }
    for (const window of windows) {
      const components = named(window.componentIds);
      if (window.stage === "completed" && components.length > 0) {
        entries.push({
          entry: {
            components,
            endsAt: iso(window.endsAt),
            id: window.id,
            kind: "maintenance",
            startsAt: iso(window.startsAt),
            title: window.title,
          },
          start: window.startsAt,
        });
      }
    }
    const place = historyMonth(
      entries.map((each) => each.start),
      month,
      now
    );
    if (!place) {
      return;
    }
    return {
      ...frame,
      entries: entries
        .filter((each) => monthOf(each.start) === place.month)
        .toSorted((a, b) => b.start - a.start)
        .map((each) => each.entry),
      month: place.month,
      next: place.next,
      previous: place.previous,
    };
  });
}

/** One incident as the page shows it: open or resolved, with every update. */
export function readIncidentView(
  storage: ViewStorage,
  pageId: string,
  incidentId: string
): Promise<ViewResult<IncidentDocument>> {
  return readView(storage, pageId, async ({ frame, named }) => {
    const incident = await storage.incidents.find(incidentId);
    const components = incident ? named(affectedComponents(incident)) : [];
    if (!incident || components.length === 0) {
      return;
    }
    return {
      ...frame,
      incident: {
        components,
        id: incident.id,
        impact: incident.impact,
        resolvedAt:
          incident.resolvedAt === undefined
            ? undefined
            : iso(incident.resolvedAt),
        stage: incidentStage(incident),
        startedAt: iso(incident.createdAt),
        title: incident.title,
        updates: incident.updates.toReversed().map((update) => ({
          at: iso(update.createdAt),
          message: update.message,
          stage: update.stage,
        })),
      },
    };
  });
}

/** One maintenance window as the page shows it, at any stage. */
export function readMaintenanceView(
  storage: ViewStorage,
  pageId: string,
  windowId: string
): Promise<ViewResult<MaintenanceDocument>> {
  return readView(storage, pageId, async ({ frame, named }) => {
    const window = await storage.maintenance.find(windowId);
    const components = window ? named(window.componentIds) : [];
    if (!window || components.length === 0) {
      return;
    }
    return {
      ...frame,
      window: {
        components,
        endsAt: iso(window.endsAt),
        id: window.id,
        message: window.message,
        stage: window.stage,
        startsAt: iso(window.startsAt),
        title: window.title,
      },
    };
  });
}

function plain(status: 404 | 503, text: string): Response {
  return new Response(text, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
    status,
  });
}

/** Whether XML 1.0 allows a character, lone surrogates aside: every one but the C0 controls other than tab, line feed and carriage return, and U+FFFE and U+FFFF. A lone surrogate never survives storage or the response's UTF-8, which both write U+FFFD for it. */
function allowedInXml(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) &&
    code !== 0xff_fe &&
    code !== 0xff_ff
  );
}

/** Text as XML character data or an attribute value: escaped, with the characters XML refuses left out, so operator text pasted with a control character never breaks a feed or a badge. */
export function xmlText(text: string): string {
  return Bun.escapeHTML([...text].filter(allowedInXml).join(""));
}

/** A public answer: the body with `Cache-Control: public`, so the memo keeps it; 404 when there is nothing at the address, 503 with no database or when it did not answer. */
export function publicResponse<Document>(
  result: ViewResult<Document> | undefined,
  type: string,
  body: (document: Document) => string,
  headers: Readonly<Record<string, string>> = {}
): Response {
  if (!result) {
    return plain(503, "Service Unavailable");
  }
  if (!result.ok) {
    return result.reason === "not_found"
      ? plain(404, "Not Found")
      : plain(503, "Service Unavailable");
  }
  return new Response(body(result.document), {
    headers: {
      ...headers,
      "cache-control": publicPolicy,
      "content-type": type,
    },
  });
}

/** A view document's public answer: the JSON with `Cache-Control: public`, 404 when there is nothing at the address, 503 with no database or when it did not answer. */
export function viewResponse<Document>(
  result: ViewResult<Document> | undefined
): Response {
  return publicResponse(result, "application/json; charset=utf-8", (document) =>
    JSON.stringify(document)
  );
}
