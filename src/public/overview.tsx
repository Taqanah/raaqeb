/**
 * A status page's frame and its overview (ADR-0006, ADR-0009).
 * The frame is what every view shows around itself: the page's name, the
 * language switcher, the footer with its links and the theme, and the
 * page's own style; it refreshes the view's document while the tab is
 * visible. The overview inside it is the banner with the page's status
 * level, the open incident and maintenance cards, its components in its
 * order with their bars and uptime, and the link to its history. Each
 * renders from its view's JSON document and nothing else, on the server
 * and in the browser. Calmer than the console, from the same design
 * language; the page's status colours, brand colour and custom CSS come
 * last, so they win.
 */
import type { ReactNode } from "react";
import { barSpans, lastDaysUptime } from "@/shared/domain/bar.ts";
import { type StatusNames, statusNamesIn } from "@/shared/domain/status.ts";
import { formatUptime } from "@/shared/i18n/format.ts";
import { directionOf, type Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Calendar } from "@/shared/schemas/clock.ts";
import type { Content } from "@/shared/schemas/content.ts";
import {
  feedUrl,
  type OverviewComponent,
  type OverviewDocument,
  type OverviewPage,
  type PublicView,
  viewPath,
} from "@/shared/schemas/overview.ts";
import { type StatusLevel, statusLevels } from "@/shared/schemas/status.ts";
import { PageStatusColours } from "@/shared/ui/badge.tsx";
import { buttonVariants } from "@/shared/ui/button.tsx";
import { Card } from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { Empty, EmptyDescription } from "@/shared/ui/empty.tsx";
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronEndIcon,
} from "@/shared/ui/icons.tsx";
import { localeNames } from "@/shared/ui/locale-switcher.tsx";
import {
  pageColourVariants,
  StatusLevelBadge,
  StatusLevelIcon,
} from "@/shared/ui/status-level.tsx";
import { spanShown } from "@/shared/ui/uptime-bar.tsx";
import { websiteHome } from "@/shared/ui/website.ts";
import { UptimeBar } from "./bar.tsx";
import { IncidentRow, MaintenanceCard } from "./cards.tsx";
import { quietLink, ViewLink } from "./link.tsx";
import { useLiveRefresh } from "./live.ts";
import { PageProse, Prose, useContent } from "./prose.tsx";
import {
  type Subscribe,
  SubscribeButton,
  SubscribeForm,
} from "./subscribe.tsx";
import { ThemeSwitch } from "./theme.tsx";
import { type TimeContext, useVisitorClock } from "./when.tsx";

const bannerWords: Readonly<Record<StatusLevel, MessageId>> = {
  degraded_performance: "public_banner_degraded_performance",
  major_outage: "public_banner_major_outage",
  operational: "public_banner_operational",
  partial_outage: "public_banner_partial_outage",
  under_maintenance: "public_banner_under_maintenance",
};

/** The status family's variable each level takes its colour from. */
const levelTokens: Readonly<Record<StatusLevel, string>> = {
  degraded_performance: "degraded",
  major_outage: "down",
  operational: "up",
  partial_outage: "partial",
  under_maintenance: "maintenance",
};

const bannerText: Readonly<Record<StatusLevel, string>> = {
  degraded_performance: "text-status-degraded-text",
  major_outage: "text-status-down-text",
  operational: "text-foreground",
  partial_outage: "text-status-partial-text",
  under_maintenance: "text-status-maintenance-text",
};

/**
 * The page's own colours and CSS as one style element: each status colour
 * a page picked replaces its level's colour and soft tint, the brand colour
 * tints its links, and the custom CSS comes last. Colours are hex by their
 * schema and the CSS never holds `</`, so neither can end the element.
 */
export function pageStyle(page: OverviewPage): string {
  const rules: string[] = [];
  for (const level of statusLevels) {
    const colour = page.statusColours[level];
    if (!colour) {
      continue;
    }
    const token = levelTokens[level];
    rules.push(
      `--status-${token}:${colour}`,
      `--status-${token}-soft:color-mix(in oklab,${colour} 14%,var(--background))`
    );
  }
  if (page.brandColour) {
    rules.push(`--brand:${page.brandColour}`);
  }
  const root = rules.length > 0 ? `:root{${rules.join(";")}}` : "";
  return `${root}${page.customCss ?? ""}`;
}

function Header({
  action,
  page,
  still,
  suffix,
  view,
}: {
  /** What the view adds beside the language switch: the overview's subscribe button. */
  readonly action: ReactNode;
  readonly page: OverviewPage;
  readonly still: boolean;
  /** The view's own part of its address, for the language switch; nothing hides the switch. */
  readonly suffix: string | undefined;
  readonly view: PublicView;
}): ReactNode {
  const { t } = useMessages();
  const other: Locale = view.locale === "ar" ? "en" : "ar";
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-border border-b pb-6">
      <div className="flex min-w-0 items-center gap-3">
        {page.images.logo ? (
          <img
            alt=""
            className="size-10 shrink-0 rounded-lg object-contain"
            height={40}
            src={page.images.logo}
            width={40}
          />
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          {/* The page's own text, inline in its language's direction, still lines up with the page's start. */}
          <h1 className="font-semibold text-lg" data-slot="page-title">
            <ViewLink
              className={quietLink}
              reload={still}
              suffix=""
              view={view}
            >
              <Prose content={page.title} />
            </ViewLink>
          </h1>
          {page.description ? (
            <p className="text-muted-foreground text-sm">
              <Prose content={page.description} />
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {suffix === undefined ? null : (
          <a
            aria-label={t("app_language")}
            className={buttonVariants({ size: "sm", variant: "outline" })}
            data-slot="page-locale"
            dir={directionOf(other)}
            href={viewPath(view.paths, other, suffix)}
            lang={other}
          >
            {localeNames[other]}
          </a>
        )}
        {action}
      </div>
    </header>
  );
}

/** The page's level as its sentence on no box, then its open incidents as rows of one card. */
function StatusCard({
  incidents,
  label,
  level,
  names,
  time,
  view,
}: {
  readonly incidents: OverviewDocument["incidents"];
  readonly label: string | undefined;
  readonly level: StatusLevel;
  readonly names: ReadonlyMap<string, Content>;
  readonly time: TimeContext;
  readonly view: PublicView;
}): ReactNode {
  const { t } = useMessages();
  return (
    <section className="flex flex-col gap-4" data-slot="page-status">
      <div
        className="flex items-center gap-3"
        data-level={level}
        data-slot="page-banner"
      >
        <p className={cn("font-semibold text-lg", bannerText[level])}>
          {label ?? t(bannerWords[level])}
        </p>
      </div>
      {incidents.length > 0 ? (
        <div className="overflow-hidden rounded-xl bg-card ring-line [&>*:first-child]:border-t-0">
          {incidents.map((incident) => (
            <IncidentRow
              incident={incident}
              key={incident.id}
              level={level}
              names={names}
              time={time}
              view={view}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** A component's uptime beside its name: over the days its bar shows at each width, or over the whole bar's length when the page hides the bar. */
function UptimeFigures({
  component,
}: {
  readonly component: OverviewComponent;
}): ReactNode {
  const { locale, t } = useMessages();
  const { days, uptime } = component;
  if (!uptime) {
    return null;
  }
  const figure = (value: NonNullable<OverviewComponent["uptime"]>) =>
    t("public_uptime", { uptime: formatUptime(locale, value) });
  if (!days) {
    return (
      <span
        className="text-muted-foreground text-xs tabular-nums"
        data-slot="uptime-figure"
      >
        {figure(uptime)}
      </span>
    );
  }
  const spans = barSpans(days.length);
  return spans.map((count, place) => {
    const shown = lastDaysUptime(days, count);
    return shown ? (
      <span
        className={cn(
          "text-muted-foreground text-xs tabular-nums",
          spanShown(place, spans.length)
        )}
        data-days={count}
        data-slot="uptime-figure"
        key={count}
      >
        {figure(shown)}
      </span>
    ) : null;
  });
}

function ComponentRow({
  calendar,
  component,
  labels,
  nested,
  view,
}: {
  readonly calendar: Calendar;
  readonly component: OverviewComponent;
  readonly labels: StatusNames;
  readonly nested: boolean;
  readonly view: PublicView;
}): ReactNode {
  return (
    <li
      className={cn(
        "flex flex-col gap-3 px-(--card-spacing) py-4",
        nested && "ps-9"
      )}
      data-component={component.id}
      data-slot="page-component"
    >
      <div className="flex items-start gap-2.5">
        <StatusLevelIcon className="mt-px" level={component.status} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-sm">
            <Prose content={component.name} />
          </span>
          {component.description ? (
            <span className="text-muted-foreground text-xs">
              <Prose content={component.description} />
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <UptimeFigures component={component} />
          <StatusLevelBadge
            // The icon carries the level; the word stays for a screen reader, and shows on a wider screen when it is not operational.
            className={
              component.status === "operational" ? "sr-only" : "max-sm:sr-only"
            }
            label={labels[component.status]}
            level={component.status}
            mark={false}
            slot="component-status"
          />
        </div>
      </div>
      {component.days ? (
        <UptimeBar
          calendar={calendar}
          days={component.days}
          labels={labels}
          percentages={component.uptime !== undefined}
          view={view}
        />
      ) : null}
    </li>
  );
}

function Components({
  document,
  view,
}: {
  readonly document: OverviewDocument;
  readonly view: PublicView;
}): ReactNode {
  const { locale, t } = useMessages();
  const labels = statusNamesIn(document.page.labels, locale);
  return (
    <section className="flex flex-col gap-3" data-slot="page-components">
      <h2 className="font-medium text-base">{t("public_components")}</h2>
      {document.items.length === 0 ? (
        <Empty>
          <EmptyDescription>{t("public_no_components")}</EmptyDescription>
        </Empty>
      ) : (
        // Nothing clips the list, so a day's card can float out of it.
        <Card className="overflow-visible py-0">
          <ul className="divide-y divide-border">
            {document.items.map((item) =>
              item.kind === "component" ? (
                <ComponentRow
                  calendar={document.calendar}
                  component={item.component}
                  key={item.component.id}
                  labels={labels}
                  nested={false}
                  view={view}
                />
              ) : (
                // A group's first component names it: a component shows once on a page, a group's name may repeat.
                <li data-slot="page-group" key={item.components[0]?.id}>
                  {/* Folded while all is well, open while any component is not; a native details, so it folds without JavaScript. */}
                  <details
                    className="group/fold"
                    open={item.status !== "operational"}
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-2.5 px-(--card-spacing) py-3 [&::-webkit-details-marker]:hidden">
                      <StatusLevelIcon level={item.status} />
                      <Prose
                        className="font-semibold text-sm"
                        content={item.name}
                      />
                      <span className="whitespace-nowrap text-muted-foreground text-xs">
                        {t("public_group_size", {
                          count: item.components.length,
                        })}
                      </span>
                      <ChevronEndIcon className="size-4 text-muted-foreground group-open/fold:hidden" />
                      <ChevronDownIcon className="hidden size-4 text-muted-foreground group-open/fold:block" />
                      <StatusLevelBadge
                        className={
                          item.status === "operational"
                            ? "sr-only"
                            : "ms-auto max-sm:sr-only"
                        }
                        label={labels[item.status]}
                        level={item.status}
                        mark={false}
                        slot="group-status"
                      />
                    </summary>
                    <ul className="divide-y divide-border border-border border-t">
                      {item.components.map((component) => (
                        <ComponentRow
                          calendar={document.calendar}
                          component={component}
                          key={component.id}
                          labels={labels}
                          nested
                          view={view}
                        />
                      ))}
                    </ul>
                  </details>
                </li>
              )
            )}
          </ul>
        </Card>
      )}
    </section>
  );
}

function Footer({ page }: { readonly page: OverviewPage }): ReactNode {
  const { locale, t } = useMessages();
  const shown = useContent();
  const link = quietLink;
  return (
    <footer className="flex flex-col gap-4 border-border border-t pt-6 text-muted-foreground text-sm">
      {page.footerLinks.length > 0 || page.contactUrl ? (
        <nav
          aria-label={t("public_footer_links")}
          className="flex flex-wrap gap-x-5 gap-y-2"
          data-slot="page-links"
        >
          {page.footerLinks.map((each, place) => {
            const label = shown(each.label);
            return (
              <a
                className={link}
                dir={label.dir}
                href={each.url}
                // biome-ignore lint/suspicious/noArrayIndexKey: the page's links in its order; two may share a URL or a label
                key={place}
                lang={label.lang}
              >
                {label.text}
              </a>
            );
          })}
          {page.contactUrl ? (
            <a className={link} data-slot="page-contact" href={page.contactUrl}>
              {t("public_contact")}
            </a>
          ) : null}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {page.poweredBy ? (
          <a
            className={`${link} text-xs`}
            data-slot="powered-by"
            // The website in the language the visitor reads, which a page shown under /en makes English.
            href={websiteHome(locale)}
            rel="noopener"
          >
            {t("public_powered_by")}
          </a>
        ) : (
          <span />
        )}
        <ThemeSwitch fallback={page.theme} />
      </div>
    </footer>
  );
}

/** The names of every component the page shows, for the cards' chips. */
function namesOf(document: OverviewDocument): Map<string, Content> {
  const names = new Map<string, Content>();
  for (const item of document.items) {
    for (const component of item.kind === "component"
      ? [item.component]
      : item.components) {
      names.set(component.id, component.name);
    }
  }
  return names;
}

/** Every view's frame: the page's header, the view, the footer and the page's own style; the view's document refreshes while the tab is visible. `suffix` is the view's own part of its address, for the language switch; a subscription's page, which has one language, passes none. */
export function PageFrame({
  action,
  children,
  page,
  still = false,
  suffix,
  view,
}: {
  /** What the view adds to the header beside the language switch. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly page: OverviewPage;
  /** A not-found: nothing to refresh, and its links load a new document, since the browser cannot read its frame again. */
  readonly still?: boolean;
  readonly suffix: string | undefined;
  readonly view: PublicView;
}): ReactNode {
  const { locale, t } = useMessages();
  useLiveRefresh(!still);
  const style = pageStyle(page);
  return (
    <div
      className="min-h-dvh bg-background text-foreground"
      data-page={page.id}
      data-slot="status-page"
    >
      {view.preview ? (
        <p
          className="border-b bg-muted px-5 py-2 text-center text-muted-foreground text-sm"
          data-slot="preview-banner"
          role="status"
        >
          {t("public_preview_banner")}
        </p>
      ) : null}
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10 sm:px-6 sm:py-14">
        <PageProse locale={page.locale} view={locale}>
          <PageStatusColours value={pageColourVariants(page.statusColours)}>
            <Header
              action={action}
              page={page}
              still={still}
              suffix={suffix}
              view={view}
            />
            {children}
            <Footer page={page} />
          </PageStatusColours>
        </PageProse>
      </main>
      {style === "" ? null : (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the page's own CSS, refused on save when it holds `</`
        <style dangerouslySetInnerHTML={{ __html: style }} />
      )}
    </div>
  );
}

/** How a view writes its times, from its document's calendar and clock and the visitor's once mounted. */
export function useViewTime(document: {
  readonly calendar: OverviewDocument["calendar"];
  readonly clock: OverviewDocument["clock"];
  readonly timeZone: string;
}): TimeContext {
  const visitor = useVisitorClock();
  return {
    calendar: document.calendar,
    clock: document.clock,
    timeZone: document.timeZone,
    visitor,
  };
}

export function Overview({
  document,
  subscribe,
  view,
}: {
  readonly document: OverviewDocument;
  /** The subscribe form's post, the route's server function. */
  readonly subscribe: Subscribe;
  readonly view: PublicView;
}): ReactNode {
  const { locale, t } = useMessages();
  const time = useViewTime(document);
  const names = namesOf(document);
  return (
    <PageFrame
      action={<SubscribeButton />}
      page={document.page}
      suffix=""
      view={view}
    >
      <StatusCard
        incidents={document.incidents}
        label={statusNamesIn(document.page.labels, locale)[document.level]}
        level={document.level}
        names={names}
        time={time}
        view={view}
      />
      {document.maintenance.map((window) => (
        <MaintenanceCard
          key={window.id}
          names={names}
          time={time}
          view={view}
          window={window}
        />
      ))}
      <Components document={document} view={view} />
      {/* Under the bars it reads from, a centred button after status.flyio.net. */}
      <p className="flex justify-center">
        <ViewLink
          className={buttonVariants({ size: "sm", variant: "outline" })}
          slot="page-history-link"
          suffix="/history"
          view={view}
        >
          <CalendarIcon />
          {t("public_history_link")}
        </ViewLink>
      </p>
      <SubscribeForm
        channels={document.subscribe}
        feed={feedUrl(view.paths, view.locale)}
        locale={view.locale}
        pageId={document.page.id}
        subscribe={subscribe}
      />
    </PageFrame>
  );
}
