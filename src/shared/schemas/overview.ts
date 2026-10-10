/**
 * The overview's JSON document (CONTEXT.md "View"; ADR-0006):
 * everything the overview of one status page shows and nothing more, the
 * one source the view renders from on the server and in the browser. It
 * carries machine values and the page's own content in each locale,
 * never interface words, so one document serves both locales. Times are ISO 8601 in UTC, days
 * are UTC dates. Served at `/api/pages/<page id>/overview`; the OpenAPI document embeds this schema.
 */
import { z } from "zod";
import { type Locale, localeSchema } from "@/shared/i18n/locale.ts";
import { themeSchema } from "./appearance.ts";
import { calendarSchema, clockSchema } from "./clock.ts";
import { contentShapeSchema } from "./content.ts";
import { impactLevelSchema, openStageSchema } from "./incident.ts";
import {
  colourSchema,
  subscriptionChannels,
  visitorLinkSchema,
} from "./page.ts";
import { statusLevelSchema } from "./status.ts";

const timestampSchema = z.iso.datetime({ offset: true });

/** The words every field holding content ends with: one text per locale, read as CONTEXT.md "Content" says. */
const perLocale = "one text per locale";

/** An uptime as a screen shows it: rounded down to `decimals` places, 100 with none when there was no downtime. */
export const uptimeFigureSchema = z.object({
  decimals: z
    .int()
    .min(0)
    .max(5)
    .describe("How many decimal places the screen shows, 0 to 5."),
  percent: z
    .number()
    .min(0)
    .max(100)
    .describe("The uptime in percent, rounded down to `decimals` places."),
});
export type UptimeFigure = z.infer<typeof uptimeFigureSchema>;

/** An incident or a maintenance window a day of the bar names, linked by its id to its view. */
export const overviewNoticeSchema = z.object({
  id: z
    .string()
    .describe(
      "The incident's or maintenance window's id, as its view's address takes it."
    ),
  title: contentShapeSchema.describe(`Its title, ${perLocale}.`),
});
export type OverviewNotice = z.infer<typeof overviewNoticeSchema>;

/** One cell of a component's day bar: a UTC day, its downtime over its observed time and the uptime they make, null when nothing was observed; its mean response time, null without a timed check; the incidents and maintenance windows that ran on it. */
export const overviewDaySchema = z.object({
  date: z.iso.date().describe("The UTC day, `yyyy-mm-dd`."),
  downtimeMs: z
    .int()
    .nonnegative()
    .describe(
      "The day's downtime in milliseconds: time in outages, counted only where it is observed time."
    ),
  incidents: z
    .array(overviewNoticeSchema)
    .describe("The incidents that ran on the day."),
  maintenance: z
    .array(overviewNoticeSchema)
    .describe("The maintenance windows that ran on the day."),
  observedMs: z
    .int()
    .nonnegative()
    .describe(
      "The day's observed time in milliseconds: the part Raaqeb had checks to judge by."
    ),
  responseMs: z
    .int()
    .nonnegative()
    .nullable()
    .describe(
      "The day's mean response time in milliseconds; null without a timed check."
    ),
  uptime: uptimeFigureSchema
    .nullable()
    .describe("The day's uptime; null when nothing was observed."),
});
export type OverviewDay = z.infer<typeof overviewDaySchema>;

export const overviewComponentSchema = z.object({
  days: z
    .array(overviewDaySchema)
    .optional()
    .describe(
      "The day bar's days, oldest first, today last; absent when the page hides the bar."
    ),
  description: contentShapeSchema
    .optional()
    .describe(
      `The component's description, ${perLocale}; absent when it has none.`
    ),
  id: z.string().describe("The component's id."),
  name: contentShapeSchema.describe(`The component's name, ${perLocale}.`),
  status: statusLevelSchema.describe("The component's status level."),
  uptime: uptimeFigureSchema
    .nullable()
    .optional()
    .describe(
      "The uptime over the bar's days; absent when the page hides percentages, null when nothing was observed."
    ),
});
export type OverviewComponent = z.infer<typeof overviewComponentSchema>;

/** One entry of the page's component list: a component, or a group with its aggregate status. */
export const overviewItemSchema = z.discriminatedUnion("kind", [
  z.object({
    component: overviewComponentSchema.describe("The component."),
    kind: z.literal("component").describe("A component on its own."),
  }),
  z.object({
    components: z
      .array(overviewComponentSchema)
      .describe("The group's components, in the page's order."),
    kind: z.literal("group").describe("A component group."),
    name: contentShapeSchema.describe(`The group's name, ${perLocale}.`),
    status: statusLevelSchema.describe(
      "The group's status level: the worst of its components'."
    ),
  }),
]);
export type OverviewItem = z.infer<typeof overviewItemSchema>;

/** An open incident's card: its impact first, its latest update, and the page's components it affects in the page's order. */
export const overviewIncidentSchema = z.object({
  components: z
    .array(z.string())
    .describe(
      "The ids of the page's components it affects, in the page's order."
    ),
  id: z.string().describe("The incident's id."),
  impact: impactLevelSchema.describe("The incident's impact level."),
  stage: openStageSchema.describe("The stage its latest update moved it to."),
  title: contentShapeSchema.describe(`The incident's title, ${perLocale}.`),
  update: z
    .object({
      at: timestampSchema.describe("When it was posted, in UTC."),
      message: contentShapeSchema.describe(`What it says, ${perLocale}.`),
    })
    .describe("Its latest update."),
});
export type OverviewIncident = z.infer<typeof overviewIncidentSchema>;

/** A maintenance window in progress or scheduled, with the page's components it affects in the page's order. */
export const overviewMaintenanceSchema = z.object({
  components: z
    .array(z.string())
    .describe(
      "The ids of the page's components it affects, in the page's order."
    ),
  endsAt: timestampSchema.describe("When the window ends, in UTC."),
  id: z.string().describe("The maintenance window's id."),
  message: contentShapeSchema.describe(`What the window is for, ${perLocale}.`),
  stage: z
    .enum(["scheduled", "in_progress"])
    .describe("Scheduled before it starts, in progress until it ends."),
  startsAt: timestampSchema.describe("When the window starts, in UTC."),
  title: contentShapeSchema.describe(`The window's title, ${perLocale}.`),
});
export type OverviewMaintenance = z.infer<typeof overviewMaintenanceSchema>;

/** What the page shows of itself: its text, its images' URLs and its customization. */
export const overviewPageSchema = z.object({
  brandColour: colourSchema
    .optional()
    .describe("The page's brand colour, `#rrggbb`; absent for the default."),
  contactUrl: visitorLinkSchema
    .optional()
    .describe(
      "The page's contact link, an https, http or mailto link; absent when it has none."
    ),
  customCss: z
    .string()
    .optional()
    .describe(
      "The page's own CSS, added after its styles; absent when it has none."
    ),
  description: contentShapeSchema
    .optional()
    .describe(`The page's description, ${perLocale}; absent when it has none.`),
  footerLinks: z
    .array(
      z.object({
        label: contentShapeSchema.describe(`The link's text, ${perLocale}.`),
        url: visitorLinkSchema.describe(
          "Where the link leads: an https, http or mailto link."
        ),
      })
    )
    .describe("The links in the page's footer, in order."),
  id: z.string().describe("The status page's id."),
  images: z
    .object({
      cover: z.string().optional().describe("The cover image's URL."),
      favicon: z.string().optional().describe("The favicon's URL."),
      logo: z.string().optional().describe("The logo's URL."),
    })
    .describe(
      "The URLs of the page's images, each carrying the image's hash; an image the page lacks is absent."
    ),
  labels: z
    .partialRecord(statusLevelSchema, contentShapeSchema)
    .describe(
      `The page's own name for a status level, ${perLocale}; a level with none shows Raaqeb's word.`
    ),
  locale: localeSchema.describe(
    "The page language: the language of its plain address."
  ),
  noindex: z
    .boolean()
    .describe("Whether the page asks search engines not to index it."),
  poweredBy: z
    .boolean()
    .describe("Whether the page shows its Powered by Raaqeb link."),
  statusColours: z
    .partialRecord(statusLevelSchema, colourSchema)
    .describe(
      "The page's own colour for a status level, `#rrggbb`; a level with none has the default."
    ),
  theme: themeSchema.describe(
    "The page's theme: the visitor's system setting, light or dark."
  ),
  title: contentShapeSchema.describe(`The page's title, ${perLocale}.`),
});
export type OverviewPage = z.infer<typeof overviewPageSchema>;

export const overviewDocumentSchema = z.object({
  calendar: calendarSchema.describe(
    "The install's calendar, which visitors read dates in."
  ),
  clock: clockSchema.describe(
    "The install's clock, 12-hour or 24-hour, which visitors read times in."
  ),
  incidents: z
    .array(overviewIncidentSchema)
    .describe("Open incidents touching the page's components, newest first."),
  items: z
    .array(overviewItemSchema)
    .describe(
      "The page's component list in its order: components and component groups."
    ),
  level: statusLevelSchema.describe(
    "The page's status level, which the banner shows."
  ),
  maintenance: z
    .array(overviewMaintenanceSchema)
    .describe(
      "Maintenance windows in progress first, then scheduled ones, each soonest first."
    ),
  page: overviewPageSchema.describe(
    "What the page shows of itself: its text, its images' URLs and its customization."
  ),
  subscribe: z
    .array(z.enum(subscriptionChannels))
    .describe(
      "The channels the subscribe form offers: the ones the page shows, email only while an email channel exists; none hides the form."
    ),
  timeZone: z
    .string()
    .describe(
      "The install's time zone, an IANA name: the server's first paint writes times in it with its label; the browser then shows its own zone."
    ),
});
export type OverviewDocument = z.infer<typeof overviewDocumentSchema>;

/** What a public response carries, so the memo keeps it and a browser revalidates it on every visit. */
export const publicPolicy = "public, max-age=0, must-revalidate";

/** Where a browser fetches a page's overview document. */
export function overviewUrl(pageId: string): string {
  return `/api/pages/${encodeURIComponent(pageId)}/overview`;
}

/** Where one page lives in each locale on the host that asked, and the origin it is known by. */
export interface PagePaths {
  /** The page's plain address in each locale on this host, with no trailing slash: empty at the bare host, `/en`, `/status/<slug>`, `/en/status/<slug>`. Every view hangs from it. */
  readonly bases: Readonly<Record<Locale, string>>;
  /** The origin the addresses and the canonical address hang from: the public address, or the custom domain over https; nothing when no public address is stored. */
  readonly origin: string | undefined;
}

/** A page's badge, feed and Statuspage-compatible summary, each after its plain address. The badge and the feed have the other locale under its prefix; the summary is one document at the page's own plain address. */
export const resourceNames = ["badge", "feed", "summary"] as const;
export type ResourceName = (typeof resourceNames)[number];
export const resourceSuffixes: Readonly<Record<ResourceName, string>> = {
  badge: "/badge.svg",
  feed: "/feed.atom",
  summary: "/api/v2/summary.json",
};

/** The path of the page's view in a locale: its base and the view's own part (empty for the overview, `/history`, `/incidents/<id>`). */
export function viewPath(
  paths: PagePaths,
  locale: Locale,
  suffix: string
): string {
  return `${paths.bases[locale]}${suffix}` || "/";
}

/** The page's plain address in a locale: absolute on its origin, the path alone when it has none. */
export function plainUrl(paths: PagePaths, locale: Locale): string {
  return paths.origin
    ? `${paths.origin}${paths.bases[locale]}`
    : viewPath(paths, locale, "");
}

/** The page's feed in a locale, which a feed reader is given: absolute on its origin, the path alone when it has none. */
export function feedUrl(paths: PagePaths, locale: Locale): string {
  return `${paths.origin ?? ""}${viewPath(paths, locale, resourceSuffixes.feed)}`;
}

/** The status page view a document shows, as the entry resolved it: the page, the locale and its addresses. */
export interface PublicView {
  readonly locale: Locale;
  readonly pageId: string;
  readonly paths: PagePaths;
  /** The signed-in operator's preview of an unpublished page, which says so above the page; never a visitor's. */
  readonly preview?: boolean;
}

/** A public view as a not-found carries it to the browser. */
export const publicViewSchema = z.object({
  locale: localeSchema,
  pageId: z.string(),
  paths: z
    .object({
      bases: z.object({ ar: z.string(), en: z.string() }),
      origin: z.string().optional(),
    })
    // No origin may travel as no key at all; the view names it as undefined.
    .transform(({ bases, origin }): PagePaths => ({ bases, origin })),
});
