/**
 * The OpenAPI document of Raaqeb's public API:
 * OpenAPI 3.1, whose schema dialect is JSON Schema 2020-12, so every schema
 * in it is Zod's own `z.toJSONSchema` of the shared schema the route
 * answers with. It holds heartbeat ingest, `GET /health`, a status page's
 * images, the JSON document of each of its views, its Statuspage-compatible
 * summary, its badge and its feed, a subscription's confirm and
 * unsubscribe, and itself, served at `/api/openapi.json`; each step that
 * builds a public route adds it here, and a test holds the list to the
 * route files. Under `webhooks` it documents what Raaqeb sends: the generic
 * webhook's signed POST, one entry per notification type, and
 * what a subscriber's webhook receives. There is no management
 * API. For the tools that read it: every operation has a tag and an
 * operationId, every body sits once under `components.schemas` and is named
 * by `$ref`, and every property says what it means through the shared
 * schema's own description.
 */
import { z } from "zod";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { healthReportSchema } from "@/shared/schemas/health.ts";
import { heartbeatTokenSchema } from "@/shared/schemas/heartbeat.ts";
import {
  type NotificationType,
  notificationPayloadSchema,
} from "@/shared/schemas/notification.ts";
import { overviewDocumentSchema } from "@/shared/schemas/overview.ts";
import { pageImageKindSchema } from "@/shared/schemas/page.ts";
import {
  confirmationWebhookSchema,
  type SubscriberEventType,
  subscriberEventTypes,
  subscriberWebhookSchema,
  subscriptionTokenSchema,
} from "@/shared/schemas/subscription.ts";
import {
  summaryComponentSchema,
  summaryDocumentSchema,
  summaryUpdateSchema,
} from "@/shared/schemas/summary.ts";
import {
  historyDocumentSchema,
  incidentDocumentSchema,
  maintenanceDocumentSchema,
  monthSchema,
} from "@/shared/schemas/views.ts";

/** An OpenAPI 3.1 document as plain JSON. */
export interface OpenApiDocument {
  /** The schemas several operations share, each written once and named by a `$ref` to `#/components/schemas/<name>`. */
  readonly components: {
    readonly schemas: Readonly<Record<string, Record<string, unknown>>>;
  };
  readonly info: {
    readonly description: string;
    readonly title: string;
    readonly version: string;
  };
  readonly openapi: "3.1.1";
  readonly paths: Readonly<Record<string, unknown>>;
  readonly servers: readonly {
    readonly description: string;
    readonly url: string;
  }[];
  readonly tags: readonly {
    readonly description: string;
    readonly name: string;
  }[];
  /** What Raaqeb sends: the generic webhook's signed POST, one entry per notification type, and a subscriber's webhook's bodies. */
  readonly webhooks: Readonly<Record<string, unknown>>;
}

/** A shared schema as the document embeds it: the document names the dialect, so no `$schema` key. */
function schemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema);
  return rest;
}

const capitalized = (word: string) =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
const wordSeparator = /[._]/;
/** A dotted or snake name in one word: `monitor.degraded_started` is `MonitorDegradedStarted`. */
const joined = (name: string) =>
  name.split(wordSeparator).map(capitalized).join("");

const componentPrefix = "#/components/schemas/";

/**
 * The schemas the document writes once under `components` and names by
 * `$ref`: every body, and the parts several bodies share, the page's
 * customization inside each view document among them. Zod writes them from a
 * registry of its own, so a reference between two of them is a `$ref` too.
 */
const components = z.registry<{ id: string }>();
for (const [id, schema] of [
  ["ConfirmationWebhook", confirmationWebhookSchema],
  ["HealthReport", healthReportSchema],
  ["HistoryDocument", historyDocumentSchema],
  ["IncidentDocument", incidentDocumentSchema],
  ["MaintenanceDocument", maintenanceDocumentSchema],
  ["OverviewDocument", overviewDocumentSchema],
  ["StatusPage", overviewDocumentSchema.shape.page],
  ["SubscriberWebhook", subscriberWebhookSchema],
  ["SummaryComponent", summaryComponentSchema],
  ["SummaryDocument", summaryDocumentSchema],
  ["SummaryUpdate", summaryUpdateSchema],
  ...notificationPayloadSchema.options.map(
    (option) =>
      [`${joined(option.shape.type.value)}Notification`, option] as const
  ),
] as const) {
  components.add(schema, { id });
}

/** A `$ref` to a schema under `components`; a schema not there is a bug in this file, so it throws. */
function refTo(schema: z.ZodType): { readonly $ref: string } {
  const id = components.get(schema)?.id;
  if (id === undefined) {
    throw new Error("the schema is not one of the document's components");
  }
  return { $ref: `${componentPrefix}${id}` };
}

function componentSchemas(): Record<string, Record<string, unknown>> {
  const { schemas } = z.toJSONSchema(components, {
    uri: (id) => `${componentPrefix}${id}`,
  });
  return Object.fromEntries(
    Object.entries(schemas).map(([id, { $id: _, $schema: __, ...schema }]) => [
      id,
      schema,
    ])
  );
}

/** The document's areas, as a viewer groups its operations. */
const tags = {
  Heartbeats: "The address a job calls to tell its heartbeat monitor it ran.",
  Meta: "The install itself: its health, this document, and the reverse proxy's custom domain check.",
  "Status pages":
    "A published status page's view documents, images, summary, badge and feed, public to anyone.",
  Subscriptions:
    "A subscription's confirm and unsubscribe links, as the subscriber's email or webhook carries them.",
  Webhooks:
    "What Raaqeb sends: a webhook channel's signed notifications, and a subscriber's webhook's events.",
} as const;
type Tag = keyof typeof tags;

/** A path's methods, each tagged and with an operationId of the method and the path's name, so a generated client's names stay put. */
function pathItem(
  name: string,
  tag: Tag,
  methods: Readonly<Record<string, object>>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(methods).map(([method, operation]) => [
      method,
      { ...operation, operationId: `${method}${name}`, tags: [tag] },
    ])
  );
}

/** Where each path parameter's value comes from, in one wording wherever the name recurs. */
const pathParameterWords = {
  id: "The status page's id: `page.id` in any of its view documents, or the last part of its address in the admin area, `/admin/pages/<id>`.",
  incidentId:
    "The incident's id, as the overview's open incidents, a day of a component's bar or a history entry gives it.",
  kind: "Which of the page's images: its logo, favicon or cover.",
  locale:
    "The page's other language. Its own language is its plain address, with no prefix.",
  month:
    "A UTC month, `yyyy-mm`, as a history document's `month`, `previous` and `next` give it.",
  slug: "The status page's slug: the last part of its address `/status/<slug>`.",
  token:
    "The secret in the URL Raaqeb gave out: a heartbeat monitor's, shown in its Heartbeat URL panel, or a subscription's, in the links its subscriber was sent.",
  windowId:
    "The maintenance window's id, as the overview's windows, a day of a component's bar or a history entry gives it.",
} as const;

function pathParameter(
  name: keyof typeof pathParameterWords,
  schema: Record<string, unknown> = { type: "string" }
) {
  return {
    description: pathParameterWords[name],
    in: "path",
    name,
    required: true,
    schema,
  };
}

const plainText = (text: string, description: string) => ({
  content: { "text/plain": { schema: { const: text, type: "string" } } },
  description,
});

// One operation for each method the job may use: curl's default GET, a HEAD from a probe, a POST from a webhook.
const ingest = {
  description:
    "Records a heartbeat for the heartbeat monitor with this token, by whichever method the job finds easiest.",
  parameters: [pathParameter("token", schemaOf(heartbeatTokenSchema))],
  responses: {
    200: plainText("OK", "The heartbeat was recorded. A HEAD gets no body."),
    404: plainText("Not Found", "No heartbeat monitor has this token."),
    503: plainText(
      "Service Unavailable",
      "The database is not open or did not answer."
    ),
  },
  summary: "Record a heartbeat",
};

/** The reverse proxy's question before it issues a certificate on demand, as Caddy's `on_demand_tls { ask … }` asks it. */
const customDomain = {
  description:
    "Whether a custom domain may have a certificate issued on demand by the reverse proxy, asked before each one as Caddy's `on_demand_tls { ask … }` asks it.",
  parameters: [
    {
      description:
        "The host name the certificate is for; Caddy appends it as `?domain=`.",
      in: "query",
      name: "domain",
      required: true,
      schema: { type: "string" },
    },
  ],
  responses: {
    200: plainText(
      "OK",
      "A published status page holds this custom domain, so it may have a certificate. A HEAD gets no body."
    ),
    404: plainText(
      "Not Found",
      "No published status page holds this domain, or the text names no domain."
    ),
    503: plainText(
      "Service Unavailable",
      "The database is not open or did not answer."
    ),
  },
  summary: "Check a custom domain",
};

/** A status page's logo, favicon or cover image: a GET or a HEAD, on any host that serves the page. */
const pageImage = {
  parameters: [
    pathParameter("id"),
    pathParameter("kind", schemaOf(pageImageKindSchema)),
    {
      description:
        "The image's SHA-256 in hex, as the page's JSON document gives it; with it the answer is cached for a year, without it revalidated.",
      in: "query",
      name: "v",
      required: false,
      schema: { type: "string" },
    },
  ],
  responses: {
    200: {
      content: {
        "image/jpeg": {},
        "image/png": {},
        "image/svg+xml": {},
        "image/webp": {},
        "image/x-icon": {},
      },
      description:
        "The image, with its ETag and a sandbox Content-Security-Policy. A HEAD gets no body.",
    },
    304: { description: "The browser holds the image the ETag names." },
    404: plainText(
      "Not Found",
      "No such page, kind or image, or the page is not published and the request carries no operator session; the operator gets an unpublished page's image with `Cache-Control: no-store`."
    ),
    503: plainText(
      "Service Unavailable",
      "The database is not open or did not answer."
    ),
  },
  summary: "A status page's image",
};

/** What a view's document answers for a page that is not published. */
const unpublishedDocument =
  "A page that is not published is not found, except to the signed-in operator, who gets its document with `Cache-Control: no-store`. While no database is open no page is found.";

/** A status page output's 503: with no database open it answers 404, so only a failed read is unavailable. */
const pageUnavailable = plainText(
  "Service Unavailable",
  "The database did not answer."
);

/** A status page's overview document: the one source its overview renders from, memoised and revalidated. */
const pageOverview = {
  parameters: [pathParameter("id")],
  responses: {
    200: {
      content: {
        "application/json": { schema: refTo(overviewDocumentSchema) },
      },
      description:
        "The overview: the page's status level, its open incidents, its maintenance windows in progress or scheduled, and its components with their bars and uptime; each day of a bar carries its downtime, observed time and mean response time, and the incidents and maintenance windows that ran on it. It carries an ETag and `Cache-Control: public, max-age=0, must-revalidate`; it changes when anything it shows changes, and at most five minutes after the clock moves today's figures. A HEAD gets no body.",
    },
    304: { description: "The ETag the request holds is still the document's." },
    404: plainText("Not Found", `No such page. ${unpublishedDocument}`),
    503: pageUnavailable,
  },
  summary: "A status page's overview document",
};

/** A status page's other view's document: memoised and revalidated as the overview's is. */
function viewDocument(
  schema: z.ZodType,
  parameters: readonly Record<string, unknown>[],
  summary: string,
  description: string,
  missing: string
) {
  return {
    parameters: [pathParameter("id"), ...parameters],
    responses: {
      200: {
        content: { "application/json": { schema: refTo(schema) } },
        description: `${description} It carries the page's own content in each locale, images and customization and the install's clock and calendar, an ETag, and \`Cache-Control: public, max-age=0, must-revalidate\`. A HEAD gets no body.`,
      },
      304: {
        description: "The ETag the request holds is still the document's.",
      },
      404: plainText("Not Found", `${missing} ${unpublishedDocument}`),
      503: pageUnavailable,
    },
    summary,
  };
}

const historyDescription =
  "The page's resolved incidents and completed maintenance windows that started in the month (UTC), newest first, with the months before and after inside the history, which runs from the month of the page's oldest entry, or of the day bar's first day when that is earlier, to the current month.";

const currentHistory = viewDocument(
  historyDocumentSchema,
  [],
  "A status page's history this month",
  historyDescription,
  "No such page."
);

const monthHistory = viewDocument(
  historyDocumentSchema,
  [pathParameter("month", schemaOf(monthSchema))],
  "A status page's history for one month",
  historyDescription,
  "No such page, or the month is outside its history."
);

const incidentView = viewDocument(
  incidentDocumentSchema,
  [pathParameter("incidentId")],
  "One incident as a status page shows it",
  "The incident's impact, stage and times, the page's components it affects, and every update, newest first.",
  "No such page, or no such incident on a component the page shows."
);

const maintenanceView = viewDocument(
  maintenanceDocumentSchema,
  [pathParameter("windowId")],
  "One maintenance window on a status page",
  "The window's stage, times and text, and the page's components it affects.",
  "No such page, or no such window on a component the page shows."
);

const slugParameter = pathParameter("slug");
const localeParameter = pathParameter("locale", schemaOf(localeSchema));

/** A page's summary, badge or feed at one of its addresses: memoised and revalidated as a view's document is. */
function pageResource(
  type: string,
  content: Record<string, unknown>,
  parameters: readonly Record<string, unknown>[],
  summary: string,
  description: string
) {
  return {
    parameters,
    responses: {
      200: {
        content: { [type]: content },
        description: `${description} It carries an ETag and \`Cache-Control: public, max-age=0, must-revalidate\`. A HEAD gets no body.`,
      },
      304: {
        description: "The ETag the request holds is still the answer's.",
      },
      404: plainText(
        "Not Found",
        "No page at this address, or no such address for it, or the page is not published, or no database is open."
      ),
      503: pageUnavailable,
    },
    summary,
  };
}

const summaryDescription =
  "The page in the shape of Statuspage's `/api/v2/summary.json`: its components in its order, a group before its members; its open incidents with their updates newest first; its maintenance windows in progress and scheduled; and `status.indicator`, the worse of the page's status level mapped (under maintenance to `maintenance`, degraded performance to `minor`, partial outage to `major`, major outage to `critical`) and the highest impact of its open incidents. Machine values only, one document for both locales.";

const badgeDescription =
  "An SVG badge: a dot in the colour of the page's status level and the level's name in the address's language, or the page's own name for it. Served under a sandbox Content-Security-Policy.";

const feedDescription =
  "An Atom feed of the page's incidents and maintenance windows, the 50 changed last, each linking to its view and holding its updates. Words in the address's language, and so is the incidents' and windows' own content where it is written in it, else the page language's.";

/** The summary, badge and feed paths: each at a page's plain address, the badge and feed also under the other locale's prefix. */
function pageResources(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const add = (
    path: string,
    name: string,
    operation: ReturnType<typeof pageResource>
  ) => {
    paths[path] = pathItem(name, "Status pages", {
      get: operation,
      head: operation,
    });
  };
  for (const [base, parameters, by] of [
    ["", [], ""],
    ["/status/{slug}", [slugParameter], "BySlug"],
  ] as const) {
    add(
      `${base}/api/v2/summary.json`,
      `Summary${by}`,
      pageResource(
        "application/json",
        { schema: refTo(summaryDocumentSchema) },
        parameters,
        "A status page's summary",
        summaryDescription
      )
    );
  }
  for (const [base, parameters, by] of [
    ["", [], ""],
    ["/{locale}", [localeParameter], "ByLocale"],
    ["/status/{slug}", [slugParameter], "BySlug"],
    [
      "/{locale}/status/{slug}",
      [localeParameter, slugParameter],
      "ByLocaleAndSlug",
    ],
  ] as const) {
    add(
      `${base}/badge.svg`,
      `Badge${by}`,
      pageResource(
        "image/svg+xml",
        {},
        parameters,
        "A status page's badge",
        badgeDescription
      )
    );
    add(
      `${base}/feed.atom`,
      `Feed${by}`,
      pageResource(
        "application/atom+xml",
        {},
        parameters,
        "A status page's feed",
        feedDescription
      )
    );
  }
  return paths;
}

/** The three Standard Webhooks headers every webhook carries. */
const webhookHeaders = [
  {
    description:
      "The notification's id: the same on every retry, so a receiver can drop a duplicate.",
    in: "header",
    name: "webhook-id",
    required: true,
    schema: { type: "string" },
  },
  {
    description: "When this attempt was made, in Unix seconds.",
    in: "header",
    name: "webhook-timestamp",
    required: true,
    schema: { pattern: "^[0-9]+$", type: "string" },
  },
  {
    description:
      "`v1,` and the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the bytes that the base64 after the signing secret's `whsec_` prefix decodes to.",
    in: "header",
    name: "webhook-signature",
    required: true,
    schema: { type: "string" },
  },
];

/** A webhook's operation: Raaqeb posts the body; its title is the name in words (`monitor.degraded_started` is "Monitor degraded started") and its operationId send and the name. */
function webhook(
  name: string,
  description: string,
  parameters: typeof webhookHeaders,
  schema: z.ZodType
) {
  const words = name.split(wordSeparator);
  return {
    post: {
      description,
      operationId: `send${joined(name)}`,
      parameters,
      requestBody: {
        content: { "application/json": { schema: refTo(schema) } },
        required: true,
      },
      responses: {
        "2XX": {
          description:
            "Received. Any other answer, a redirect included, is a failed attempt, tried again 30 seconds, 2 minutes and 10 minutes later.",
        },
      },
      summary: capitalized(words.join(" ")),
      tags: ["Webhooks"],
    },
  };
}

/** When a webhook channel gets each notification, as the notifications docs say it. */
const sentWhen: Readonly<Record<NotificationType, string>> = {
  "channel.test": "Sent when the operator presses the channel's send test.",
  "monitor.certificate_expiring":
    "Sent when an HTTPS monitor's certificate expires within the monitor's warning threshold, then once more within one day. A new certificate starts over.",
  "monitor.degraded_ended":
    "Sent when a check is up again after the monitor was degraded. A degraded monitor that goes down sends only `monitor.down`.",
  "monitor.degraded_started":
    "Sent when a check succeeds but is slower than the monitor's degraded threshold.",
  "monitor.down":
    "Sent when an outage opens: the first check that confirms the monitor is down. A late heartbeat is down for a heartbeat monitor.",
  "monitor.recovered":
    "Sent when the outage closes: the first check that is no longer down.",
  "monitor.reminder":
    "Sent every so many minutes, as the monitor's reminder sets, while it stays down and its outage is not acknowledged.",
};

/** One webhook per notification type: what Raaqeb posts to a generic webhook channel. */
function webhooks(): Record<string, unknown> {
  const entries = notificationPayloadSchema.options.map((option) => {
    const type = option.shape.type.value;
    return [type, webhook(type, sentWhen[type], webhookHeaders, option)];
  });
  return { ...Object.fromEntries(entries), ...subscriberWebhooks() };
}

/** Where an incident's first word on a component comes from: the status it showed before, kept from the update that first names it. */
const incidentBefore =
  " On the update that first names a component, `old_status` is the status the page showed for it just before; an incident opened before Raaqeb kept that status says `operational`.";

/** When each event is sent, and what it adds: where an incident's first `old_status` comes from, what a window's one update says of the page's affected components, when scheduled is not sent, and the reschedule and cancel. */
const events: Readonly<
  Record<SubscriberEventType, { readonly note?: string; readonly when: string }>
> = {
  "incident.published": {
    note: incidentBefore,
    when: "an incident on a component the page shows is published",
  },
  "incident.updated": {
    note: incidentBefore,
    when: "an incident on a component the page shows gets an update, the resolving one included",
  },
  "maintenance.cancelled": {
    note: " A scheduled window was cancelled before it started: the window has `status` `completed` and `resolved_at` the cancel's time, as Statuspage ends a maintenance, and this event's name is how a consumer tells a cancel from an end. Its update lists no component, since the window never moved a status, and its `shortlink` is the page's plain address, since the window's own view is gone.",
    when: "a maintenance window on a component the page shows is cancelled before it starts",
  },
  "maintenance.completed": {
    note: " Its update lists each of the page's affected components with `old_status` `under_maintenance` and `new_status` the status it holds after.",
    when: "a maintenance window on a component the page shows ends",
  },
  "maintenance.rescheduled": {
    note: " An edit moved the window's start or end, while scheduled or in progress: `scheduled_for` and `scheduled_until` carry the new times, `status` its stage, and its update, stamped with the edit, lists no component, since new times change no status. Not sent when the start or the end moves to the current minute, which sends `maintenance.started` or `maintenance.completed` instead.",
    when: "an edit moves the start or end of a maintenance window on a component the page shows",
  },
  "maintenance.scheduled": {
    note: " Its update lists no component, since scheduling changes no status. Not sent for a window that starts in the current minute, which sends `maintenance.started` alone.",
    when: "a maintenance window on a component the page shows is scheduled",
  },
  "maintenance.started": {
    note: " Its update lists each of the page's affected components with `old_status` the status it held before and `new_status` `under_maintenance`.",
    when: "a maintenance window on a component the page shows starts",
  },
};

/** What a subscriber's webhook receives: the first POST, and Statuspage's body for each event. No signature. */
function subscriberWebhooks(): Record<string, unknown> {
  const headers = webhookHeaders.slice(0, 2);
  return {
    "subscription.confirmation": webhook(
      "subscription.confirmation",
      "Sent to a subscriber's webhook first, when it subscribes: the link to the page where a person confirms the subscription by pressing its button, within 48 hours. Nothing else is sent until then.",
      headers,
      confirmationWebhookSchema
    ),
    ...Object.fromEntries(
      subscriberEventTypes.map((type) => [
        type,
        webhook(
          type,
          `Sent to a subscriber's webhook when ${events[type].when}, in the body Statuspage sends its webhook subscribers; a maintenance window is an incident with impact maintenance. Its text is in the subscription language, else the page language, and its links lead to the subscription language's views.${events[type].note ?? ""}`,
          headers,
          subscriberWebhookSchema
        ),
      ])
    ),
  };
}

/** A subscription's confirm or unsubscribe: a POST that acts, and a GET that only leads to the subscription's page. */
function subscriptionAction(action: "confirm" | "unsubscribe") {
  const token = pathParameter("token", schemaOf(subscriptionTokenSchema));
  const toPage = {
    description:
      "To the subscription's page, which says where the subscription stands.",
    headers: { location: { schema: { type: "string" } } },
  };
  return pathItem(
    action === "confirm" ? "SubscriptionConfirm" : "SubscriptionUnsubscribe",
    "Subscriptions",
    {
      get: {
        description: `Leads to the subscription's page, where the ${action} button is; a GET changes nothing, so a mail scanner that opens links acts on none.`,
        parameters: [token],
        responses: { 303: toPage },
        summary: "Lead to the subscription's page",
      },
      post: {
        description:
          action === "confirm"
            ? "Confirms a pending subscription while its link is younger than 48 hours."
            : "Unsubscribes, whatever the subscription's state; an email client's one-click unsubscribe (RFC 8058) posts here with `List-Unsubscribe=One-Click`.",
        parameters: [token],
        responses: {
          ...(action === "unsubscribe"
            ? {
                200: plainText(
                  "Unsubscribed",
                  "An email client's one-click unsubscribe (RFC 8058), which follows no redirect."
                ),
              }
            : {}),
          303: toPage,
          404: plainText("Not Found", "No subscription has this token."),
          503: plainText(
            "Service Unavailable",
            "The database is not open or did not answer."
          ),
        },
        summary:
          action === "confirm" ? "Confirm a subscription" : "Unsubscribe",
      },
    }
  );
}

const report = {
  content: { "application/json": { schema: refTo(healthReportSchema) } },
};

/** The document as a reader that resolves every `$ref` sees it: each one replaced by the schema it names; a `$ref` to no schema throws. */
export function inlineSchemas(document: OpenApiDocument): OpenApiDocument {
  const { schemas } = document.components;
  const inline = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(inline);
    }
    return typeof value === "object" && value !== null ? record(value) : value;
  };
  const record = (value: object): Record<string, unknown> => {
    const { $ref, ...rest } = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, inline(child)])
    );
    if (typeof $ref !== "string") {
      return rest;
    }
    const named = schemas[$ref.replace(componentPrefix, "")];
    if (!named) {
      throw new Error(`the OpenAPI document has no schema ${$ref}`);
    }
    // A keyword beside the $ref, a property's own description, wins over the named schema's.
    return { ...record(named), ...rest };
  };
  return {
    ...document,
    components: {
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([id, schema]) => [id, record(schema)])
      ),
    },
    paths: record(document.paths),
    webhooks: record(document.webhooks),
  };
}

export function openApiDocument(): OpenApiDocument {
  return {
    components: { schemas: componentSchemas() },
    info: {
      description:
        "Raaqeb's public API: a status page's read-only status data (its view documents, images, Statuspage-compatible summary, badge and feed), heartbeat ingest, and a subscription's confirm and unsubscribe. Its webhooks are what Raaqeb sends. There is no management API: the operator manages the install in its admin area.",
      title: "Raaqeb public API",
      version: "1",
    },
    openapi: "3.1.1",
    paths: {
      ...pageResources(),
      "/api/custom-domain": pathItem("CustomDomainCheck", "Meta", {
        get: customDomain,
        head: customDomain,
      }),
      "/api/heartbeat/{token}": pathItem("Heartbeat", "Heartbeats", {
        get: ingest,
        head: ingest,
        post: ingest,
      }),
      "/subscriptions/{token}/confirm": subscriptionAction("confirm"),
      "/subscriptions/{token}/unsubscribe": subscriptionAction("unsubscribe"),
      "/api/openapi.json": pathItem("OpenApiDocument", "Meta", {
        get: {
          responses: {
            200: {
              content: {
                "application/json": {
                  schema: {
                    description:
                      "An OpenAPI 3.1 document: this one, whose schemas are JSON Schema 2020-12.",
                    type: "object",
                  },
                },
              },
              description:
                "This document, OpenAPI 3.1, cached for an hour: it changes only with the binary.",
            },
          },
          summary: "The OpenAPI document",
        },
      }),
      "/api/pages/{id}/history": pathItem("PageHistory", "Status pages", {
        get: currentHistory,
        head: currentHistory,
      }),
      "/api/pages/{id}/history/{month}": pathItem(
        "PageHistoryMonth",
        "Status pages",
        { get: monthHistory, head: monthHistory }
      ),
      "/api/pages/{id}/incidents/{incidentId}": pathItem(
        "PageIncident",
        "Status pages",
        { get: incidentView, head: incidentView }
      ),
      "/api/pages/{id}/maintenance/{windowId}": pathItem(
        "PageMaintenanceWindow",
        "Status pages",
        { get: maintenanceView, head: maintenanceView }
      ),
      "/api/pages/{id}/overview": pathItem("PageOverview", "Status pages", {
        get: pageOverview,
        head: pageOverview,
      }),
      "/api/pages/{id}/{kind}": pathItem("PageImage", "Status pages", {
        get: pageImage,
        head: pageImage,
      }),
      "/health": pathItem("Health", "Meta", {
        get: {
          responses: {
            200: {
              ...report,
              description:
                "The database answered and the scheduler ticked, or the install is in onboarding.",
            },
            503: {
              ...report,
              description:
                "The database did not answer or the scheduler's last tick is stale.",
            },
          },
          summary: "Liveness of the database and scheduler",
        },
      }),
    },
    servers: [
      {
        description:
          "The install's public address, which the operator sets in onboarding and in the settings: every path is relative to it.",
        url: "/",
      },
    ],
    tags: Object.entries(tags).map(([name, description]) => ({
      description,
      name,
    })),
    webhooks: webhooks(),
  };
}
