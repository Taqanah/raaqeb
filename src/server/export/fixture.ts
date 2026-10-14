/**
 * Test support for export and import: a source install on its own SQLite
 * file holding every kind of record an export carries, and an empty target
 * install on the run's backend (Postgres under `bun run test:postgres`).
 * Not product code.
 */

import { betterAuthSecrets } from "@/server/auth/secret.ts";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import type { InstallKey } from "@/server/boot/installkey.ts";
import { encrypt } from "@/server/boot/installkey.ts";
import { sealCredentials } from "@/server/monitors/credentials.ts";
import { sealSecrets } from "@/server/notify/secrets.ts";
import { releaseCheckEnabled } from "@/server/release/release.ts";
import { publicAddress } from "@/server/settings/address.ts";
import {
  appearanceDensity,
  appearanceFontSize,
  appearanceRadius,
  appearanceTheme,
} from "@/server/settings/appearance.ts";
import { calendar, clock, timeZone } from "@/server/settings/clock.ts";
import { installLanguage } from "@/server/settings/language.ts";
import {
  operatorCalendar,
  operatorLanguage,
} from "@/server/settings/operator.ts";
import { retentionDays, sizeBudgetBytes } from "@/server/settings/retention.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import { sqliteFileName } from "@/server/storage/sqlite.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import type { CheckResult } from "@/shared/schemas/check.ts";
import {
  type MonitorFields,
  monitorEventKinds,
} from "@/shared/schemas/monitor.ts";
import { pageCustomizationSchema } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";

export const day = 86_400_000;
export const hour = 3_600_000;
export const minute = 60_000;

/** Noon of the scratch installs' today, a UTC day with a morning of checks behind it. */
export const today = Date.UTC(2026, 8, 28);
export const now = today + 12 * hour;

/** The webhook subscriber's URL, sealed in the source and in clear in the file. */
export const subscriberUrl = "https://hooks.example.test/raaqeb";
/** An HTTP monitor's basic password, sealed in the source and in clear in the file. */
export const monitorPassword = "monitor password 7";
/** The webhook channel's URL and signing secret, sealed in the source and in clear in the file. */
export const channelUrl = "https://alerts.example.test/hook?key=abc";
// A secret of the shape the webhook makes, so an import takes it as its form would.
export const signingSecret =
  "whsec_AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=";

export interface Install {
  /** Moves the storage's clock, which stamps every row it writes. */
  readonly at: (time: number) => void;
  readonly cleanup: () => Promise<void>;
  readonly key: InstallKey;
  readonly location: DatabaseLocation;
  readonly storage: Storage;
}

async function install(
  location: DatabaseLocation,
  cleanup: () => Promise<void>
): Promise<Install> {
  let time = now;
  const opened = await openStorage(location, { now: () => time });
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  return {
    at: (next) => {
      time = next;
    },
    cleanup: async () => {
      await opened.storage.close();
      await cleanup();
    },
    key: await scratchInstallKey(),
    location,
    storage: opened.storage,
  };
}

/** An empty install on the run's backend, with the public address its onboarding stored and its own install key. */
export async function targetInstall(): Promise<Install> {
  const scratch = await scratchDatabase();
  const target = await install(scratch.location, scratch.cleanup);
  await target.storage.settings.set(
    publicAddress,
    "https://target.example.test"
  );
  await target.storage.settings.set(installLanguage, "ar");
  return target;
}

/** The ids of what `sourceInstall` holds. */
export interface SourceIds {
  readonly api: string;
  readonly backup: string;
  readonly dns: string;
  readonly email: string;
  readonly payments: string;
  readonly statusPage: string;
  readonly webhook: string;
  readonly website: string;
}

const httpMonitor: MonitorFields = {
  channels: [],
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url: "https://api.example.test/health",
  },
  degradedMs: 800,
  description: "The public API",
  events: ["down", "recovered"],
  group: "Core",
  intervalMs: 20 * minute,
  name: "API",
  reminderMs: hour,
  retentionDays: 400,
  retries: 1,
  tags: ["eu", "prod"],
  timeoutMs: 10_000,
};

/**
 * A SQLite install on its own file holding every kind of record: three
 * monitors (one with credentials, one heartbeat paused), a group and tags,
 * two channels with secrets, two components, two pages with a layout and a
 * logo, an open and a resolved incident, a window, an email and a webhook
 * subscription, every setting, and history of every kind: today's checks,
 * a closed day still in the head, two sealed days, two days of hourly
 * rollups alone, one day of a daily rollup alone, and two outages, the
 * open one acknowledged.
 */
export async function sourceInstall(): Promise<Install & { ids: SourceIds }> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  const source = await install(
    { backend: "sqlite", file: `${dir}/${sqliteFileName}` },
    async () => {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  );
  const { key, storage } = source;
  source.at(today - 300 * day);

  const webhook = await storage.channels.create(
    {
      appliesToNew: true,
      config: {},
      locale: undefined,
      name: "Ops webhook",
      type: "webhook",
    },
    await sealSecrets(key, { secret: signingSecret, url: channelUrl })
  );
  const email = await storage.channels.create(
    {
      appliesToNew: false,
      config: {
        from: "Raaqeb <raaqeb@example.test>",
        host: "smtp.example.test",
        port: "587",
        security: "starttls",
        to: "ops@example.test",
        username: "raaqeb",
      },
      locale: "en",
      name: "Ops mail",
      type: "email",
    },
    await sealSecrets(key, { password: "smtp password" })
  );
  const api = await storage.monitors.create(
    { ...httpMonitor, channels: [webhook.id] },
    await sealCredentials(key, {
      auth: { kind: "basic", password: monitorPassword, user: "raaqeb" },
      headers: [{ name: "X-Api-Key", value: "header secret" }],
    })
  );
  const backup = await storage.monitors.create({
    channels: [email.id],
    config: { schedule: { everyMs: day, kind: "every" }, type: "heartbeat" },
    events: [...monitorEventKinds],
    intervalMs: 60_000,
    name: "Nightly backup",
    retries: 0,
    tags: ["prod"],
    timeoutMs: 10_000,
  });
  source.at(today - 250 * day);
  await storage.monitors.pause([backup.id]);
  const dns = await storage.monitors.create({
    channels: [],
    config: { name: "example.test", recordType: "A", type: "dns" },
    events: [...monitorEventKinds],
    intervalMs: 5 * minute,
    name: "DNS",
    retries: 2,
    tags: [],
    timeoutMs: 5000,
  });

  const website = await storage.components.create({
    description: { en: "The site visitors use" },
    monitorIds: [api.id],
    name: { ar: "الموقع", en: "Website" },
    status: "operational",
  });
  const payments = await storage.components.create({
    description: undefined,
    monitorIds: [],
    name: { ar: "المدفوعات", en: "Payments" },
    status: "degraded_performance",
  });
  const customization = pageCustomizationSchema.parse({});
  const statusPage = await storage.pages.create({
    customDomain: "status.example.test",
    customization,
    isDefault: true,
    locale: "ar",
    published: true,
    slug: "main",
    title: { ar: "حالة الخدمات", en: "Service status" },
  });
  await storage.pages.save(statusPage.id, statusPage, [
    {
      componentIds: [website.id],
      kind: "group",
      name: { ar: "الأساس", en: "Core" },
    },
    { componentId: payments.id, kind: "component" },
  ]);
  const logo = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
  ]);
  await storage.pages.setImage(statusPage.id, {
    body: logo,
    contentType: "image/png",
    hash: new Bun.CryptoHasher("sha256").update(logo).digest("hex"),
    kind: "logo",
  });
  const english = await storage.pages.create({
    customDomain: undefined,
    customization,
    isDefault: false,
    locale: "en",
    // A page not yet published, which travels as one.
    published: false,
    slug: "english",
    title: { en: "Service status" },
  });
  await storage.pages.save(english.id, english, [
    { componentId: payments.id, kind: "component" },
  ]);

  source.at(today - 20 * day);
  const resolved = await storage.incidents.create(
    { impact: "major", title: { ar: "أخطاء الدفع", en: "Checkout errors" } },
    {
      author: "operator@example.test",
      before: new Map([[payments.id, "degraded_performance"]]),
      message: { ar: "نتحقق من الأمر.", en: "We are looking into it." },
      stage: "investigating",
      statuses: [{ componentId: payments.id, status: "partial_outage" }],
    }
  );
  source.at(today - 20 * day + hour);
  await storage.incidents.post(
    resolved.id,
    {
      author: "operator@example.test",
      message: { en: "Fixed." },
      stage: "resolved",
      statuses: [{ componentId: payments.id, status: "operational" }],
    },
    [{ componentId: payments.id, status: "operational" }],
    resolved.updates.at(-1)?.id ?? ""
  );
  source.at(now - hour);
  await storage.incidents.create(
    { impact: "minor", title: { en: "Slow pages" } },
    {
      author: "operator@example.test",
      message: {
        ar: "الصفحات بطيئة.\n\nنعمل عليها.",
        en: "Pages load slowly.\n\nWe are on it.",
      },
      stage: "identified",
      statuses: [{ componentId: website.id, status: "degraded_performance" }],
    }
  );
  await storage.maintenance.create({
    componentIds: [website.id, payments.id],
    endsAt: today + 3 * day,
    message: { ar: "ترقية قاعدة البيانات.", en: "Database upgrade." },
    startsAt: today + 2 * day,
    title: { ar: "ترقية", en: "Upgrade" },
  });

  const confirmed = await storage.subscriptions.request({
    address: "visitor@example.test",
    channel: "email",
    credentials: undefined,
    locale: "ar",
    pageId: statusPage.id,
    quietSince: now,
    requestedAt: now - 2 * hour,
  });
  await storage.subscriptions.confirm(confirmed?.token ?? "", now - hour, 0);
  await storage.subscriptions.request({
    address: new Bun.CryptoHasher("sha256").update(subscriberUrl).digest("hex"),
    channel: "webhook",
    credentials: await encrypt(key, subscriberUrl),
    locale: "en",
    pageId: english.id,
    quietSince: now,
    requestedAt: now - hour,
  });

  await storage.settings.set(installLanguage, "en");
  await storage.settings.set(timeZone, "Asia/Riyadh");
  await storage.settings.set(clock, "24h");
  await storage.settings.set(calendar, "hijri");
  await storage.settings.set(appearanceTheme, "dark");
  await storage.settings.set(appearanceFontSize, "large");
  await storage.settings.set(appearanceDensity, "compact");
  await storage.settings.set(appearanceRadius, "large");
  await storage.settings.set(retentionDays, 120);
  await storage.settings.set(sizeBudgetBytes, 512 * 1024 * 1024);
  await storage.settings.set(releaseCheckEnabled, false);
  await storage.settings.set(publicAddress, "https://source.example.test");
  await storage.settings.set(operatorLanguage, "ar");
  await storage.settings.set(operatorCalendar, "hijri_gregorian");
  await storage.settings.set(
    betterAuthSecrets,
    "1:source-secret-source-secret-source-secret-sou"
  );

  // History: checks every 20 minutes over today's morning, yesterday (a closed day left in the head) and the two days before (sealed).
  await checksEvery(storage, api.id, today - 3 * day, now, 20 * minute);
  for (const sealed of [today - 3 * day, today - 2 * day]) {
    // biome-ignore lint/performance/noAwaitInLoops: oldest day first, as the sealing job seals
    await storage.checks.seal(api.id, sealed, 40 * minute, []);
  }
  await checksEvery(storage, dns.id, today - 5 * minute, now, 5 * minute);
  // Two days whose checks are gone and whose hourly rollups stay, and one day with its daily rollup alone.
  for (const rolled of [today - 41 * day, today - 40 * day]) {
    for (let at = rolled; at < rolled + 3 * hour; at += hour) {
      // biome-ignore lint/performance/noAwaitInLoops: one connection to the file at a time
      await runSql(
        source.location,
        "INSERT INTO hourly_rollups (monitor_id, hour, checks, observed_ms, average_ms, min_ms, max_ms, failed, degraded) VALUES (?, ?, 3, 3600000, 150, 100, 220, 1, 1)",
        [api.id, at]
      );
    }
    await runSql(
      source.location,
      "INSERT INTO daily_rollups (monitor_id, day, checks, observed_ms, average_ms, min_ms, max_ms, failed, degraded) VALUES (?, ?, 9, 10800000, 150, 100, 220, 3, 3)",
      [api.id, rolled]
    );
  }
  await runSql(
    source.location,
    "INSERT INTO daily_rollups (monitor_id, day, checks, observed_ms, average_ms, min_ms, max_ms, failed, degraded) VALUES (?, ?, 72, 86400000, 180, 90, 900, 0, 2)",
    [api.id, today - 200 * day]
  );
  await runSql(
    source.location,
    "INSERT INTO outages (monitor_id, started_at, ended_at, reason, acknowledged_at) VALUES (?, ?, ?, ?, NULL), (?, ?, NULL, ?, ?)",
    [
      api.id,
      today - 2 * day + 2 * hour,
      today - 2 * day + 3 * hour,
      reasons.timeout,
      dns.id,
      now - 5 * minute,
      reasons.dns_failed,
      now - 2 * minute,
    ]
  );
  source.at(now);
  return {
    ...source,
    ids: {
      api: api.id,
      backup: backup.id,
      dns: dns.id,
      email: email.id,
      payments: payments.id,
      statusPage: statusPage.id,
      webhook: webhook.id,
      website: website.id,
    },
  };
}

/** Records a check every `step` from `from` up to `to`, one in ten down. */
export async function checksEvery(
  storage: Storage,
  monitorId: string,
  from: number,
  to: number,
  step: number
): Promise<void> {
  let index = 0;
  for (let at = from; at < to; at += step) {
    const result: CheckResult = index % 10 === 3 ? "down" : "up";
    index += 1;
    // biome-ignore lint/performance/noAwaitInLoops: the head table's rows go in one at a time, as the scheduler writes them
    await storage.checks.record({
      capture: undefined,
      check: {
        attempts: result === "down" ? 2 : 1,
        bytes: result === "down" ? 0 : 512 + index,
        monitorId,
        reason: result === "down" ? reasons.timeout : reasons.ok,
        responseMs: result === "down" ? 10_000 : 100 + (index % 7) * 10,
        result,
        startedAt: at,
        statusCode: result === "down" ? undefined : 200,
      },
      detail: undefined,
    });
  }
}

/** Every line of a compressed export, parsed as JSON. */
export async function linesOf(
  body: ReadableStream<Uint8Array>
): Promise<Record<string, unknown>[]> {
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  const text = new TextDecoder().decode(Bun.zstdDecompressSync(bytes));
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Compresses lines as an export is, for files a test writes by hand. */
export function fileOf(lines: readonly string[]): ReadableStream<Uint8Array> {
  const text = lines.map((line) => `${line}\n`).join("");
  return new Blob([
    new Uint8Array(Bun.zstdCompressSync(new TextEncoder().encode(text))),
  ]).stream();
}
