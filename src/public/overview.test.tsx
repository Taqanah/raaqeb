import { describe, expect, test } from "bun:test";
import type {
  OverviewComponent,
  OverviewIncident,
  OverviewPage,
} from "@/shared/schemas/overview.ts";
import { plainPage, render, viewIn } from "./fixture.tsx";
import { Overview, pageStyle } from "./overview.tsx";

const plain: OverviewPage = {
  footerLinks: [],
  id: "p",
  images: {},
  labels: {},
  locale: "ar",
  noindex: false,
  poweredBy: true,
  statusColours: {},
  theme: "system",
  title: { ar: "حالة" },
};

describe("a status page's own style", () => {
  test("a page that customizes nothing writes nothing", () => {
    expect(pageStyle(plain)).toBe("");
  });

  test("a picked status colour replaces its level's colour and soft tint, and the brand colour is a variable", () => {
    expect(
      pageStyle({
        ...plain,
        brandColour: "#123456",
        statusColours: { major_outage: "#ff0000", operational: "#00aa00" },
      })
    ).toBe(
      ":root{--status-up:#00aa00;--status-up-soft:color-mix(in oklab,#00aa00 14%,var(--background));--status-down:#ff0000;--status-down-soft:color-mix(in oklab,#ff0000 14%,var(--background));--brand:#123456;--action:#123456;--action-foreground:#ffffff}"
    );
  });

  test("the brand colour fills the page's buttons, their text white or black, whichever reads better on it", () => {
    expect(pageStyle({ ...plain, brandColour: "#0055aa" })).toContain(
      "--action:#0055aa;--action-foreground:#ffffff"
    );
    expect(pageStyle({ ...plain, brandColour: "#facc15" })).toContain(
      "--action:#facc15;--action-foreground:#000000"
    );
  });

  test("the custom CSS comes last, so it wins", () => {
    expect(
      pageStyle({
        ...plain,
        customCss: ".x{color:red}",
        statusColours: { partial_outage: "#ea580c" },
      })
    ).toEndWith("}.x{color:red}");
  });
});

/** A component whose day bar shows one day, 11 September 2026. */
function shown(id: string): OverviewComponent {
  return {
    days: [
      {
        date: "2026-09-11",
        downtimeMs: 0,
        incidents: [],
        maintenance: [],
        observedMs: 0,
        responseMs: null,
        uptime: null,
      },
    ],
    id,
    name: { en: id },
    status: "operational",
  };
}

/** The page offers no subscription, so the form never posts. */
const noSubscribe = () =>
  Promise.resolve({ ok: false, reason: "invalid" } as const);

/** A bar cell named by its Hijri date: 11 September 2026 is 29 Rabi' I 1448. */
const hijriCell = /aria-label="Rab\. I 29, 1448 AH/g;
// The components card follows their heading with nothing between them.
const headingThenCard = /<\/h2><div[^>]*data-slot="card"/;

describe("a status page's day bars", () => {
  test("name their days in the install's calendar, a group's components' as a lone component's", () => {
    const html = render(
      "en",
      <Overview
        document={{
          calendar: "hijri",
          clock: "12h",
          incidents: [],
          items: [
            { component: shown("web"), kind: "component" },
            {
              components: [shown("api")],
              kind: "group",
              name: { en: "Platform" },
              status: "operational",
            },
          ],
          level: "operational",
          maintenance: [],
          page: plainPage,
          subscribe: [],
          timeZone: "Asia/Riyadh",
        }}
        subscribe={noSubscribe}
        view={viewIn("en")}
      />
    );
    expect(html.match(hijriCell)).toHaveLength(2);
  });
});

/** The credit line's link tag in a page's HTML. */
const credit = /<a[^>]*data-slot="powered-by"[^>]*>/;

describe("a status page's credit line", () => {
  function footerOf(
    locale: "ar" | "en",
    poweredBy: boolean,
    pageLocale: "ar" | "en" = locale
  ): string {
    return render(
      locale,
      <Overview
        document={{
          calendar: "gregorian",
          clock: "24h",
          incidents: [],
          items: [],
          level: "operational",
          maintenance: [],
          page: { ...plainPage, locale: pageLocale, poweredBy },
          subscribe: [],
          timeZone: "UTC",
        }}
        subscribe={noSubscribe}
        view={viewIn(locale)}
      />
    );
  }

  test("leads to Raaqeb's website in the language the visitor reads, not the page's own", () => {
    expect(footerOf("ar", true).match(credit)?.[0]).toContain(
      'href="https://raaqeb.dev/"'
    );
    expect(footerOf("en", true, "ar").match(credit)?.[0]).toContain(
      'href="https://raaqeb.dev/en"'
    );
  });

  test("opens no window that could reach back to the status page", () => {
    expect(footerOf("en", true).match(credit)?.[0]).toContain('rel="noopener"');
  });

  test("is gone when the page hides it", () => {
    expect(footerOf("en", false)).not.toContain('data-slot="powered-by"');
  });
});

/** Every subscribe card in a page's HTML. */
const subscribeCards = /data-slot="subscribe"/g;

describe("the subscribe dialog", () => {
  function pageOffering(subscribe: readonly ("email" | "webhook")[]): string {
    return render(
      "en",
      <Overview
        document={{
          calendar: "gregorian",
          clock: "24h",
          incidents: [],
          items: [],
          level: "operational",
          maintenance: [],
          page: plainPage,
          subscribe: [...subscribe],
          timeZone: "UTC",
        }}
        subscribe={noSubscribe}
        view={viewIn("en")}
      />
    ).toLowerCase();
  }

  test("the header's button opens it without JavaScript, as a native popover", () => {
    const html = pageOffering(["email"]);
    expect(html).toContain('popovertarget="subscribe-dialog"');
    expect(html).toContain('id="subscribe-dialog"');
    expect(html).toContain('popover="auto"');
  });

  test("it holds the subscribe form, and the page has no card of its own below", () => {
    const html = pageOffering(["email"]);
    const dialog = html.split('id="subscribe-dialog"')[1] ?? "";
    expect(dialog).toContain('data-slot="subscribe-form"');
    expect(html.match(subscribeCards)).toHaveLength(1);
  });

  test("a page offering no channel opens it with the feed alone", () => {
    const html = pageOffering([]);
    expect(html).toContain('popovertarget="subscribe-dialog"');
    const dialog = html.split('id="subscribe-dialog"')[1] ?? "";
    expect(dialog).toContain('data-slot="subscribe-feed"');
    expect(dialog).not.toContain('data-slot="subscribe-form"');
  });
});

describe("the status card, the page's level with its open incidents", () => {
  const slow: OverviewIncident = {
    components: ["api"],
    id: "i-1",
    impact: "minor",
    stage: "identified",
    title: { en: "Slow API" },
    update: { at: "2026-10-08T09:00:00.000Z", message: { en: "A fix is in." } },
  };
  function statusCard(incidents: readonly OverviewIncident[]): string {
    const html = render(
      "en",
      <Overview
        document={{
          calendar: "gregorian",
          clock: "24h",
          incidents: [...incidents],
          items: [
            {
              component: { ...shown("api"), status: "degraded_performance" },
              kind: "component",
            },
          ],
          level: incidents.length ? "degraded_performance" : "operational",
          maintenance: [],
          page: plainPage,
          subscribe: [],
          timeZone: "UTC",
        }}
        subscribe={noSubscribe}
        view={viewIn("en")}
      />
    );
    return (
      html.split('data-slot="page-status"')[1]?.split("</section>")[0] ?? ""
    );
  }

  test("holds the page's level and each open incident, in one card", () => {
    const card = statusCard([slow]);
    expect(card).toContain('data-slot="page-banner"');
    expect(card).toContain('data-slot="incident-card"');
    expect(card).toContain("Slow API");
  });

  test("gives an incident's stage, latest update and the components it touches on one line", () => {
    const meta =
      statusCard([slow])
        .split('data-slot="incident-meta"')[1]
        ?.split("</p>")[0] ?? "";
    expect(meta).toContain("Identified");
    expect(meta).toContain("Latest update");
    expect(meta).toContain("Affects api");
  });

  test("says the page's level as its sentence, with no icon beside it", () => {
    const banner =
      statusCard([slow])
        .split('data-slot="page-banner"')[1]
        ?.split("</div>")[0] ?? "";
    expect(banner).toContain("Degraded performance");
    expect(banner).not.toContain('data-slot="level-icon"');
  });

  test("is the level alone when nothing is open", () => {
    const card = statusCard([]);
    expect(card).toContain('data-slot="page-banner"');
    expect(card).not.toContain('data-slot="incident-card"');
  });
});

describe("a component's row", () => {
  /** A component up every day of a 90-day bar, with its uptime figure. */
  function upFor90(id: string): OverviewComponent {
    const days = Array.from({ length: 90 }, (_, age) => ({
      date: new Date(Date.UTC(2026, 9, 8) - (89 - age) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      downtimeMs: 0,
      incidents: [],
      maintenance: [],
      observedMs: 86_400_000,
      responseMs: null,
      uptime: { decimals: 0, percent: 100 },
    }));
    return {
      days,
      id,
      name: { en: id },
      status: "operational",
      uptime: { decimals: 0, percent: 100 },
    };
  }
  function page(): string {
    return render(
      "en",
      <Overview
        document={{
          calendar: "gregorian",
          clock: "24h",
          incidents: [],
          items: [{ component: upFor90("web"), kind: "component" }],
          level: "operational",
          maintenance: [],
          page: plainPage,
          subscribe: [],
          timeZone: "UTC",
        }}
        subscribe={noSubscribe}
        view={viewIn("en")}
      />
    );
  }

  test("keeps its status name for a screen reader, also when operational, where its icon leads", () => {
    const row = page().split('data-slot="page-component"')[1] ?? "";
    expect(row).toContain('data-slot="level-icon"');
    const status = row.split('data-slot="component-status"')[1] ?? "";
    expect(status).toContain(">Operational<");
    // Hidden from sight, never from the accessibility tree.
    expect(status.split(">")[0]).toContain("sr-only");
  });

  test("names a level that is not operational once by its icon, its word carrying no second mark", () => {
    const row =
      render(
        "en",
        <Overview
          document={{
            calendar: "gregorian",
            clock: "24h",
            incidents: [],
            items: [
              {
                component: { ...upFor90("api"), status: "major_outage" },
                kind: "component",
              },
              {
                components: [{ ...upFor90("db"), status: "major_outage" }],
                kind: "group",
                name: { en: "Data" },
                status: "major_outage",
              },
            ],
            level: "major_outage",
            maintenance: [],
            page: plainPage,
            subscribe: [],
            timeZone: "UTC",
          }}
          subscribe={noSubscribe}
          view={viewIn("en")}
        />
      ).split('data-slot="page-components"')[1] ?? "";
    for (const slot of ["component-status", "group-status"]) {
      const word =
        row.split(`data-slot="${slot}"`)[1]?.split("</span>")[0] ?? "";
      expect(word).toContain("Major outage");
      expect(word).not.toContain('data-slot="badge-mark"');
    }
  });

  test("gives its uptime beside its name, and its bar no caption", () => {
    const html = page();
    expect(html).not.toContain('data-slot="bar-caption"');
    const row = html.split('data-slot="page-component"')[1] ?? "";
    expect(row.split('data-slot="uptime-bar"')[0]).toContain("100% uptime");
  });

  test("the components' heading stands alone, with no small label of the days the bars span", () => {
    const section = page().split('data-slot="page-components"')[1] ?? "";
    expect(section).toMatch(headingThenCard);
  });
});

describe("a component group folds", () => {
  function groups(): string[] {
    const html = render(
      "en",
      <Overview
        document={{
          calendar: "gregorian",
          clock: "24h",
          incidents: [],
          items: [
            {
              components: [shown("web"), shown("docs")],
              kind: "group",
              name: { en: "Platform" },
              status: "operational",
            },
            {
              components: [
                shown("db"),
                { ...shown("mail"), status: "degraded_performance" },
              ],
              kind: "group",
              name: { en: "Infrastructure" },
              status: "degraded_performance",
            },
          ],
          level: "degraded_performance",
          maintenance: [],
          page: plainPage,
          subscribe: [],
          timeZone: "UTC",
        }}
        subscribe={noSubscribe}
        view={viewIn("en")}
      />
    );
    return html.split('data-slot="page-group"').slice(1);
  }

  test("starts folded when every component in it is operational, saying how many it holds", () => {
    const [platform] = groups();
    expect(platform).toContain("<details");
    expect(platform?.split(">")[1]).not.toContain(" open");
    expect(platform).toContain("2 components");
  });

  test("starts open while any component in it is not operational", () => {
    const [, infrastructure] = groups();
    expect(infrastructure?.split(">")[1]).toContain(" open");
  });
});
