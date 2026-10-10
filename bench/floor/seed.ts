/**
 * Seeding: the operator account, the fleet, its channels, its
 * status page and incidents, and a day of history, written straight into
 * the database through Raaqeb's own storage and module functions before the
 * install starts. The storage takes any interval; the 20 s minimum lives in
 * the monitors module, so the benchmark can seed the 1 s intervals of the
 * accelerated day and no product setting lowers it. The account exists so
 * the install is past onboarding and its pages render.
 */
import { authFor, operatorName } from "@/server/auth/auth.ts";
import type { InstallKey } from "@/server/boot/installkey.ts";
import { createIncident, postUpdate } from "@/server/incidents/incidents.ts";
import { sealCredentials } from "@/server/monitors/credentials.ts";
import { createChannel } from "@/server/notify/channels.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import { connectionAddress } from "@/shared/domain/monitors.ts";
import type { ChannelInput } from "@/shared/schemas/channel.ts";
import type { Check } from "@/shared/schemas/check.ts";
import {
  isDatabaseConfig,
  type MonitorFields,
} from "@/shared/schemas/monitor.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import type { FleetMember } from "./fleet.ts";

/** The operator account every seeded install has; the harness signs in with it for the uncached path alone. */
export const benchOperator = {
  email: "bench@raaqeb.invalid",
  password: "floor-benchmark-only",
} as const;

/** Where the run's notification channels deliver: Mailpit for the email channel, the target's sink for the webhook. */
export interface ChannelTargets {
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly webhookUrl: string;
}

export interface SeedOptions {
  /** The email and webhook channels the notifying monitors select; none for a run that sends nothing. */
  readonly channels: ChannelTargets | undefined;
  /** An unpublished copy of the default page, which the operator alone sees, rendered outside the memo: the throughput sweep's uncached path. */
  readonly draftPage: boolean;
  readonly fleet: readonly FleetMember[];
  /** A day of head rows for the first `monitors` checked monitors, from `dayStart`, `intervalMs` apart: the day the install seals as it starts. */
  readonly history:
    | {
        readonly dayStart: number;
        readonly intervalMs: number;
        readonly monitors: number;
      }
    | undefined;
  /** An open incident and some resolved ones on the default page. */
  readonly incidents: boolean;
  /** The install key the container boots with, which seals the channels' secrets. */
  readonly key: InstallKey;
}

/** What the harness needs of a seeded install. */
export interface Seeded {
  /** The unpublished copy's path, under `/status/`. */
  readonly draftPath: string | undefined;
  /** Every heartbeat monitor's token, which the harness sends heartbeats to. */
  readonly heartbeatTokens: readonly string[];
  /** The monitors' ids in creation order, the scheduler's list order. */
  readonly monitorIds: readonly string[];
  /** The default page, when the fleet puts a monitor on it. */
  readonly pageId: string | undefined;
}

const dayMs = 86_400_000;

/** A small seeded generator, so a synthetic day is the same on every run. */
function randomOf(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** One synthetic check: up with a lognormal response time around 120 ms, or one time in two hundred down on a refused connection. */
function syntheticCheck(
  monitorId: string,
  startedAt: number,
  random: () => number
): Check {
  if (random() < 0.005) {
    return {
      attempts: 1,
      bytes: 0,
      monitorId,
      reason: reasons.connection_refused,
      responseMs: 1,
      result: "down",
      startedAt,
      statusCode: undefined,
    };
  }
  // Box and Muller's normal from two uniforms, spread a third of a log unit.
  const normal =
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return {
    attempts: 1,
    bytes: 2,
    monitorId,
    reason: reasons.ok,
    responseMs: Math.max(1, Math.round(120 * Math.exp(normal / 3))),
    result: "up",
    startedAt,
    statusCode: 200,
  };
}

/** How many head rows the history writes in one batch. */
export const historyBatch = 5000;

/**
 * A day of synthetic checks for each monitor, one batch at a time: each
 * monitor's checks `intervalMs` apart from its own offset in the day, mostly
 * up with lognormal response times, a few down. The same day every time for
 * the same arguments, so runs of one build seal the same rows.
 */
export function* syntheticDay(
  monitorIds: readonly string[],
  dayStart: number,
  intervalMs: number
): Generator<Check[]> {
  let batch: Check[] = [];
  for (const [index, monitorId] of monitorIds.entries()) {
    const random = randomOf(index + 1);
    // Each monitor's own place in the interval, as the scheduler spreads them.
    const offset = (index * 997) % intervalMs;
    for (let at = dayStart + offset; at < dayStart + dayMs; at += intervalMs) {
      batch.push(syntheticCheck(monitorId, at, random));
      if (batch.length === historyBatch) {
        yield batch;
        batch = [];
      }
    }
  }
  if (batch.length > 0) {
    yield batch;
  }
}

/** Migrates the database, creates the operator account, the fleet, its channels, page and incidents, and its history, and closes it again. */
export async function seedInstall(
  location: DatabaseLocation,
  options: SeedOptions
): Promise<Seeded> {
  const opened = await openStorage(location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  const { storage } = opened;
  try {
    // Created the way onboarding does, on the server through auth.api (e2e/support/serve-en.ts).
    const auth = await authFor(storage, {
      betterAuthSecrets: undefined,
      installKey: options.key,
    });
    await auth.api.signUpEmail({
      body: { ...benchOperator, name: operatorName },
    });
    const channels = options.channels
      ? await seedChannels(storage, options.key, options.channels)
      : [];
    const monitorIds: string[] = [];
    const heartbeatTokens: string[] = [];
    for (const member of options.fleet) {
      // biome-ignore lint/performance/noAwaitInLoops: one insert at a time keeps the creation order, the scheduler's list order
      const monitor = await storage.monitors.create(
        withAddress(
          { ...member.fields, channels: member.notifies ? channels : [] },
          member.connectionUrl
        ),
        member.connectionUrl === undefined
          ? undefined
          : await sealCredentials(options.key, {
              headers: [],
              url: member.connectionUrl,
            })
      );
      monitorIds.push(monitor.id);
      if (member.role === "heartbeat") {
        const token = await storage.monitors.heartbeatTokenOf(monitor.id);
        if (token) {
          heartbeatTokens.push(token);
        }
      }
    }
    const onPage = monitorIds.filter(
      (_, index) => options.fleet[index]?.onPage
    );
    const page =
      onPage.length === 0
        ? undefined
        : await seedPages(storage, onPage, options.draftPage);
    if (page && options.incidents) {
      await seedIncidents(storage, page.components);
    }
    if (options.history) {
      const { dayStart, intervalMs, monitors } = options.history;
      const checked = monitorIds
        .filter((_, index) => options.fleet[index]?.role !== "heartbeat")
        .slice(0, monitors);
      for (const batch of syntheticDay(checked, dayStart, intervalMs)) {
        // biome-ignore lint/performance/noAwaitInLoops: one batch at a time bounds what the harness holds
        await storage.transfer.writeChecks(batch);
      }
    }
    return {
      draftPath: page?.draftSlug && `/status/${page.draftSlug}`,
      heartbeatTokens,
      monitorIds,
      pageId: page?.id,
    };
  } finally {
    await storage.close();
  }
}

/** A database monitor's fields with the address the list shows, written from its URL as the monitors module writes it. */
function withAddress(
  fields: MonitorFields,
  url: string | undefined
): MonitorFields {
  const { config } = fields;
  return url !== undefined && isDatabaseConfig(config)
    ? {
        ...fields,
        config: { ...config, address: connectionAddress(config.type, url) },
      }
    : fields;
}

/** The slugs of the default page and of its unpublished copy. */
const pageSlug = "bench";
const draftSlug = "bench-draft";

/** The email channel through the SMTP sink, with no login (Mailpit takes any), and the webhook to the target's sink; their ids. */
async function seedChannels(
  storage: Storage,
  key: InstallKey,
  targets: ChannelTargets
): Promise<string[]> {
  const inputs: ChannelInput[] = [
    {
      appliesToNew: false,
      name: "Bench email",
      type: "email",
      values: {
        from: "bench@raaqeb.invalid",
        host: targets.smtpHost,
        port: String(targets.smtpPort),
        security: "none",
        to: "operator@raaqeb.invalid",
      },
    },
    {
      appliesToNew: false,
      name: "Bench webhook",
      type: "webhook",
      values: { url: targets.webhookUrl },
    },
  ];
  const ids: string[] = [];
  for (const input of inputs) {
    // biome-ignore lint/performance/noAwaitInLoops: one channel at a time, in order
    const saved = await createChannel(storage, key, input);
    if (!saved.ok) {
      throw new Error(`the ${input.type} channel was refused: ${saved.reason}`);
    }
    ids.push(saved.channel.id);
  }
  return ids;
}

/** One component per monitor on the default page, and the unpublished copy when asked. */
async function seedPages(
  storage: Storage,
  monitorIds: readonly string[],
  draft: boolean
): Promise<{
  components: string[];
  draftSlug: string | undefined;
  id: string;
}> {
  const components: string[] = [];
  for (const [index, monitorId] of monitorIds.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one insert at a time keeps the page's order
    const component = await storage.components.create({
      description: undefined,
      monitorIds: [monitorId],
      name: { ar: `Service ${String(index + 1).padStart(2, "0")}` },
      status: "operational",
    });
    components.push(component.id);
  }
  const layout = components.map((componentId) => ({
    componentId,
    kind: "component" as const,
  }));
  const page = async (slug: string, published: boolean) => {
    const created = await storage.pages.create({
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: published,
      locale: "en",
      published,
      slug,
      title: { en: "Bench status" },
    });
    await storage.pages.save(created.id, { ...created }, layout);
    return created.id;
  };
  const id = await page(pageSlug, true);
  if (draft) {
    await page(draftSlug, false);
  }
  return { components, draftSlug: draft ? draftSlug : undefined, id };
}

/** One open incident on the page's first component, and two resolved ones for its history. */
async function seedIncidents(
  storage: Storage,
  components: readonly string[]
): Promise<void> {
  const [first, second] = components;
  if (!(first && second)) {
    return;
  }
  const incidents = [
    {
      componentId: first,
      open: true,
      title: "Slow responses on the first service",
    },
    { componentId: second, open: false, title: "An earlier outage" },
    { componentId: first, open: false, title: "An older outage" },
  ];
  for (const incident of incidents) {
    // biome-ignore lint/performance/noAwaitInLoops: one incident at a time, each read by the next
    const created = await createIncident(
      storage,
      {
        impact: "minor",
        message: { ar: "We are looking into it." },
        stage: "investigating",
        statuses: [
          {
            componentId: incident.componentId,
            status: incident.open ? "degraded_performance" : "partial_outage",
          },
        ],
        title: { ar: incident.title },
      },
      benchOperator.email
    );
    if (!created.ok) {
      throw new Error(`the incident was refused: ${created.reason}`);
    }
    if (!incident.open) {
      await postUpdate(
        storage,
        created.incident.id,
        { keep: false, message: { ar: "Resolved." }, stage: "resolved" },
        benchOperator.email
      );
    }
  }
}
