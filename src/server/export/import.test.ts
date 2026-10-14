import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { decrypt } from "@/server/boot/installkey.ts";
import {
  openCredentials,
  sealCredentials,
} from "@/server/monitors/credentials.ts";
import { imagePolicy, pageImageResponse } from "@/server/pages/images.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { calendar, timeZone } from "@/server/settings/clock.ts";
import { installLanguage } from "@/server/settings/language.ts";
import { operatorCalendar } from "@/server/settings/operator.ts";
import { runSql } from "@/server/storage/fixture.ts";
import { pageImageKinds, pageImageMaxBytes } from "@/shared/schemas/page.ts";
import { exportInstall } from "./export.ts";
import {
  checksEvery,
  day,
  fileOf,
  hour,
  type Install,
  linesOf,
  minute,
  monitorPassword,
  now,
  sourceInstall,
  subscriberUrl,
  targetInstall,
  today,
} from "./fixture.ts";
import { importInstall } from "./import.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function source() {
  const install = await sourceInstall();
  cleanups.push(install.cleanup);
  return install;
}

async function target() {
  const install = await targetInstall();
  cleanups.push(install.cleanup);
  return install;
}

/** The install's export as lines of text, compressed again so a test can change them. */
async function exportLines(
  install: Install,
  mode: "full" | "configuration" = "full"
): Promise<string[]> {
  const started = await exportInstall(install.storage, install.key, mode, now);
  if (!started.ok) {
    throw new Error(`the export did not start: ${started.reason}`);
  }
  return (await linesOf(started.body)).map((line) => JSON.stringify(line));
}

/** Every line of the install's export but the header's time. */
async function records(install: Install): Promise<unknown[]> {
  const lines = (await exportLines(install)).map((line) => JSON.parse(line));
  lines[0].exportedAt = undefined;
  return lines;
}

async function count(install: Install, table: string): Promise<number> {
  const [row] = await runSql(
    install.location,
    `SELECT count(*) AS n FROM ${table}`
  );
  return Number(row?.n);
}

/** Whether the install is as empty as a fresh one: no monitor, page, component, incident, window or history. */
async function empty(install: Install): Promise<boolean> {
  for (const table of [
    "monitors",
    "status_pages",
    "components",
    "incidents",
    "maintenance_windows",
    "groups",
    "tags",
    "checks",
    "outages",
    "hourly_rollups",
    "daily_rollups",
    "sealed_days",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one count after another is plenty for a test
    if ((await count(install, table)) > 0) {
      return false;
    }
  }
  return true;
}

describe("an import", () => {
  test("of an export from a SQLite install into an empty install round-trips every record and answers how many monitors, pages and records it wrote", async () => {
    const from = await source();
    const into = await target();
    const answer = await importInstall(
      into.storage,
      into.key,
      fileOf(await exportLines(from)),
      now
    );
    const written = await records(from);
    expect(answer).toEqual({
      monitors: 3,
      ok: true,
      pages: 2,
      records: written.length - 1,
    });
    expect(await records(into)).toEqual(written);
  });

  test("carries a database monitor's connection URL in clear in the file and seals it again with this install's key", async () => {
    const from = await source();
    const url = "mysql://watcher:s3cret@db.example.test/app?sslmode=require";
    const database = await from.storage.monitors.create(
      {
        channels: [],
        config: { address: "db.example.test:3306", type: "mysql" },
        events: [],
        intervalMs: 60_000,
        name: "قاعدة الطلبات",
        retries: 0,
        tags: [],
        timeoutMs: 10_000,
      },
      await sealCredentials(from.key, { headers: [], url })
    );
    const lines = await exportLines(from, "configuration");
    expect(lines[0]).toContain(JSON.stringify(url).slice(1, -1));
    const into = await target();
    expect(
      (await importInstall(into.storage, into.key, fileOf(lines), now)).ok
    ).toBe(true);
    const sealed = await into.storage.monitors.credentialsOf(database.id);
    expect(sealed).not.toContain("s3cret");
    expect(await openCredentials(into.key, sealed ?? "")).toEqual({
      headers: [],
      url,
    });
    expect((await into.storage.monitors.find(database.id))?.target).toBe(
      "db.example.test:3306"
    );
  });

  test("carries each piece of content in both locales, an empty translation still empty", async () => {
    const from = await source();
    const into = await target();
    await importInstall(
      into.storage,
      into.key,
      fileOf(await exportLines(from, "configuration")),
      now
    );
    const components = await into.storage.components.list();
    expect(components.map((each) => [each.name, each.description])).toEqual([
      [{ ar: "الموقع", en: "Website" }, { en: "The site visitors use" }],
      [{ ar: "المدفوعات", en: "Payments" }, undefined],
    ]);
    const [main, english] = await into.storage.pages.list();
    expect(main?.title).toEqual({ ar: "حالة الخدمات", en: "Service status" });
    expect(english?.title).toEqual({ en: "Service status" });
    expect(await into.storage.pages.layout(main?.id ?? "")).toMatchObject([
      { kind: "group", name: { ar: "الأساس", en: "Core" } },
      { kind: "component" },
    ]);
    const incidents = await into.storage.incidents.list();
    expect(incidents.map((each) => each.title)).toEqual([
      { ar: "أخطاء الدفع", en: "Checkout errors" },
      { en: "Slow pages" },
    ]);
    expect(incidents[0]?.updates.map((each) => each.message)).toEqual([
      { ar: "نتحقق من الأمر.", en: "We are looking into it." },
      { en: "Fixed." },
    ]);
  });

  test("carries a Docker monitor's endpoint and container as they were, with its target", async () => {
    const from = await source();
    const docker = await from.storage.monitors.create(
      {
        channels: [],
        config: {
          container: "orders-api",
          endpoint: "http://socket-proxy:2375",
          type: "docker",
        },
        events: [],
        intervalMs: 60_000,
        name: "واجهة الطلبات",
        retries: 0,
        tags: [],
        timeoutMs: 10_000,
      },
      undefined
    );
    const lines = await exportLines(from, "configuration");
    const into = await target();
    expect(
      (await importInstall(into.storage, into.key, fileOf(lines), now)).ok
    ).toBe(true);
    const imported = await into.storage.monitors.find(docker.id);
    expect(imported?.config).toEqual(docker.config);
    expect(imported?.target).toBe("orders-api");
  });

  test("seals every credential again with this install's key, which the other install's key cannot open", async () => {
    const from = await source();
    const into = await target();
    await importInstall(
      into.storage,
      into.key,
      fileOf(await exportLines(from)),
      now
    );
    const sealed = await into.storage.monitors.credentialsOf(from.ids.api);
    expect(sealed).toBeDefined();
    expect((await openCredentials(into.key, sealed ?? ""))?.auth).toEqual({
      kind: "basic",
      password: monitorPassword,
      user: "raaqeb",
    });
    expect(await decrypt(from.key, sealed ?? "")).toBeUndefined();
    const [subscription] = await runSql(
      into.location,
      "SELECT credentials FROM subscriptions WHERE channel = 'webhook'"
    );
    expect(await decrypt(into.key, String(subscription?.credentials))).toBe(
      subscriberUrl
    );
  });

  test("keeps a webhook subscriber apart by the SHA-256 of its URL, computed again from the URL", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from, "configuration");
    const header = JSON.parse(lines[0] ?? "{}");
    for (const row of header.configuration.subscriptions) {
      if (row.channel === "webhook") {
        row.address = "not the hash";
      }
    }
    await importInstall(
      into.storage,
      into.key,
      fileOf([JSON.stringify(header)]),
      now
    );
    const [subscription] = await runSql(
      into.location,
      "SELECT address FROM subscriptions WHERE channel = 'webhook'"
    );
    expect(subscription?.address).toBe(
      new Bun.CryptoHasher("sha256").update(subscriberUrl).digest("hex")
    );
  });

  test("seals each monitor's closed days and leaves today's checks in the head", async () => {
    const from = await source();
    const into = await target();
    await importInstall(
      into.storage,
      into.key,
      fileOf(await exportLines(from)),
      now
    );
    const head = await runSql(
      into.location,
      "SELECT DISTINCT started_at - started_at % 86400000 AS day FROM checks"
    );
    expect(head.map((row) => Number(row.day))).toEqual([today]);
    const sealed = await runSql(
      into.location,
      "SELECT day FROM sealed_days WHERE monitor_id = ? ORDER BY day",
      [from.ids.api]
    );
    expect(sealed.map((row) => Number(row.day))).toEqual([
      today - 3 * day,
      today - 2 * day,
      today - day,
    ]);
    expect(
      await into.storage.checks.rollups(from.ids.api, "day", today - day, today)
    ).toHaveLength(1);
  });

  test("gives a day that came as hourly rollups its daily rollup, summed from them", async () => {
    const from = await source();
    const into = await target();
    await importInstall(
      into.storage,
      into.key,
      fileOf(await exportLines(from)),
      now
    );
    expect(
      await into.storage.checks.rollups(
        from.ids.api,
        "day",
        today - 40 * day,
        today - 39 * day
      )
    ).toEqual([
      {
        at: today - 40 * day,
        averageMs: 150,
        checks: 9,
        degraded: 3,
        failed: 3,
        maxMs: 220,
        minMs: 100,
        monitorId: from.ids.api,
        observedMs: 3 * hour,
      },
    ]);
  });

  test("writes the settings that travel over the install's own and keeps the rest of its own", async () => {
    const from = await source();
    const into = await target();
    // The target operator's own calendar, which the source's own (hijri_gregorian) must not replace.
    await into.storage.settings.set(operatorCalendar, "gregorian");
    await importInstall(
      into.storage,
      into.key,
      fileOf(await exportLines(from)),
      now
    );
    expect(await into.storage.settings.get(installLanguage)).toBe("en");
    expect(await into.storage.settings.get(timeZone)).toBe("Asia/Riyadh");
    expect(await into.storage.settings.get(calendar)).toBe("hijri");
    expect(await into.storage.settings.get(publicAddress)).toBe(
      "https://target.example.test"
    );
    expect(await into.storage.settings.get(operatorCalendar)).toBe("gregorian");
  });

  test("moves the change counter once, at its end", async () => {
    const from = await source();
    const into = await target();
    const before = await into.storage.changeCounter();
    await importInstall(
      into.storage,
      into.key,
      fileOf(await exportLines(from)),
      now
    );
    expect(await into.storage.changeCounter()).toBe(before + 1);
  });

  test("of the configuration mode writes the configuration and no history", async () => {
    const from = await source();
    const into = await target();
    const answer = await importInstall(
      into.storage,
      into.key,
      fileOf(await exportLines(from, "configuration")),
      now
    );
    expect(answer).toEqual({ monitors: 3, ok: true, pages: 2, records: 0 });
    expect(await count(into, "monitors")).toBe(3);
    expect(await count(into, "checks")).toBe(0);
  });

  test("is refused by an install that holds a monitor, a page or a component, and writes nothing", async () => {
    const from = await source();
    const into = await target();
    await into.storage.components.create({
      description: undefined,
      monitorIds: [],
      name: { ar: "Web" },
      status: "operational",
    });
    const before = await into.storage.changeCounter();
    expect(
      await importInstall(
        into.storage,
        into.key,
        fileOf(await exportLines(from)),
        now
      )
    ).toEqual({ ok: false, reason: "not_empty" });
    expect(await count(into, "monitors")).toBe(0);
    expect(await into.storage.settings.get(installLanguage)).toBe("ar");
    expect(await into.storage.changeCounter()).toBe(before);
  });

  test("carries the status a component had before an incident, and reads one from a file written before Raaqeb kept it as unknown", async () => {
    const from = await source();
    const exported = await exportLines(from, "configuration");
    const header = JSON.parse(exported[0] ?? "{}");
    const kept = header.configuration.incidentStatuses.filter(
      (each: { statusBefore: string | null }) => each.statusBefore !== null
    );
    expect(
      kept.map((each: { statusBefore: string }) => each.statusBefore)
    ).toEqual(["degraded_performance"]);
    const into = await target();
    for (const each of header.configuration.incidentStatuses) {
      each.statusBefore = undefined;
    }
    expect(
      await importInstall(
        into.storage,
        into.key,
        fileOf([JSON.stringify(header)]),
        now
      )
    ).toMatchObject({ ok: true });
    const [row] = await runSql(
      into.location,
      "SELECT count(*) AS n FROM incident_statuses WHERE status_before IS NOT NULL"
    );
    expect(Number(row?.n)).toBe(0);
    expect(
      (await into.storage.incidents.list()).flatMap((incident) =>
        incident.updates.flatMap((update) =>
          update.statuses.filter((each) => "before" in each)
        )
      )
    ).toEqual([]);
  });

  test("carries when an outage was acknowledged, and reads an outage from a file written before Raaqeb kept it as not acknowledged", async () => {
    const from = await source();
    const lines = await exportLines(from);
    const into = await target();
    await importInstall(into.storage, into.key, fileOf(lines), now);
    expect(
      (await into.storage.outages.ongoing()).map((each) => each.acknowledgedAt)
    ).toEqual([now - 2 * minute]);
    const older = await target();
    const withoutField = lines.map((line) => {
      const record = JSON.parse(line);
      if (record.kind !== "outage") {
        return line;
      }
      record.acknowledgedAt = undefined;
      return JSON.stringify(record);
    });
    expect(withoutField.join("\n")).not.toContain("acknowledgedAt");
    expect(
      await importInstall(older.storage, older.key, fileOf(withoutField), now)
    ).toMatchObject({ ok: true });
    const outages = await older.storage.outages.ongoing();
    expect(outages).toHaveLength(1);
    expect(outages[0]?.acknowledgedAt).toBeUndefined();
  });

  test("of a file of another version is refused as such", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from, "configuration");
    const header = JSON.parse(lines[0] ?? "{}");
    header.version = 2;
    expect(
      await importInstall(
        into.storage,
        into.key,
        fileOf([JSON.stringify(header)]),
        now
      )
    ).toEqual({ ok: false, reason: "version" });
  });

  test("of bytes that are not an export is refused at its first line", async () => {
    const into = await target();
    expect(
      await importInstall(
        into.storage,
        into.key,
        new Blob(["not zstd"]).stream(),
        now
      )
    ).toEqual({ line: 1, ok: false, reason: "invalid" });
    expect(
      await importInstall(into.storage, into.key, fileOf(["{}"]), now)
    ).toEqual({ line: 1, ok: false, reason: "invalid" });
    expect(
      await importInstall(into.storage, into.key, fileOf([]), now)
    ).toEqual({ line: 1, ok: false, reason: "invalid" });
  });

  test("that fails at a line takes out everything it wrote, leaves the install's settings and counter as they were, and names the line", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from);
    const broken = [...lines.slice(0, 40), "{not json", ...lines.slice(40)];
    const before = await into.storage.changeCounter();
    expect(
      await importInstall(into.storage, into.key, fileOf(broken), now)
    ).toEqual({ line: 41, ok: false, reason: "invalid" });
    expect(await empty(into)).toBe(true);
    expect(await count(into, "channels")).toBe(0);
    expect(await count(into, "subscriptions")).toBe(0);
    expect(await into.storage.settings.get(installLanguage)).toBe("ar");
    expect(await into.storage.changeCounter()).toBe(before);
  });

  test("refuses a record of a monitor its configuration does not hold", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from);
    const stray = JSON.parse(lines[5] ?? "{}");
    stray.monitor = "no-such-monitor";
    const broken = [
      ...lines.slice(0, 5),
      JSON.stringify(stray),
      ...lines.slice(6),
    ];
    expect(
      await importInstall(into.storage, into.key, fileOf(broken), now)
    ).toEqual({ line: 6, ok: false, reason: "invalid" });
    expect(await empty(into)).toBe(true);
  });

  test("refuses history after a header of the configuration mode", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from);
    const header = JSON.parse(lines[0] ?? "{}");
    header.mode = "configuration";
    expect(
      await importInstall(
        into.storage,
        into.key,
        fileOf([JSON.stringify(header), ...lines.slice(1)]),
        now
      )
    ).toEqual({ line: 2, ok: false, reason: "invalid" });
    expect(await empty(into)).toBe(true);
  });

  test("keeps a channel the install already has under the same id, and takes out none of the install's own when it fails", async () => {
    const from = await source();
    const into = await target();
    const first = await importInstall(
      into.storage,
      into.key,
      fileOf(await exportLines(from, "configuration")),
      now
    );
    expect(first.ok).toBe(true);
    await into.storage.monitors.remove([
      from.ids.api,
      from.ids.backup,
      from.ids.dns,
    ]);
    await Promise.all(
      (await into.storage.pages.list()).map((page) =>
        into.storage.pages.remove(page.id)
      )
    );
    await Promise.all(
      (await into.storage.components.list()).map((component) =>
        into.storage.components.remove(component.id)
      )
    );
    await Promise.all(
      (await into.storage.incidents.list()).map((incident) =>
        into.storage.incidents.remove(incident.id)
      )
    );
    await Promise.all(
      (await into.storage.maintenance.list()).map((window) =>
        into.storage.maintenance.remove(window.id)
      )
    );
    await into.storage.channels.update(from.ids.email, {
      appliesToNew: false,
      config: {},
      locale: undefined,
      name: "Renamed here",
      type: "email",
    });
    const lines = await exportLines(from);
    const broken = [...lines, "{not json"];
    expect(
      (await importInstall(into.storage, into.key, fileOf(broken), now)).ok
    ).toBe(false);
    expect((await into.storage.channels.find(from.ids.email))?.name).toBe(
      "Renamed here"
    );
    expect(
      await importInstall(into.storage, into.key, fileOf(lines), now)
    ).toMatchObject({ ok: true });
    expect((await into.storage.channels.find(from.ids.email))?.name).toBe(
      "Renamed here"
    );
  });

  test("runs one at a time: of two at once, the second meets the first one's monitors", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from);
    const answers = await Promise.all([
      importInstall(into.storage, into.key, fileOf(lines), now),
      importInstall(into.storage, into.key, fileOf(lines), now),
    ]);
    expect(answers.map((answer) => answer.ok).sort()).toEqual([false, true]);
    expect(answers).toContainEqual({ ok: false, reason: "not_empty" });
  });

  test("round-trips a monitor with more records than one batch writes", async () => {
    const from = await source();
    const into = await target();
    await checksEvery(
      from.storage,
      from.ids.dns,
      today - day,
      today - day + 1300 * minute,
      minute
    );
    const lines = await exportLines(from);
    expect(
      lines.filter((line) => line.includes(from.ids.dns)).length
    ).toBeGreaterThan(1300);
    await importInstall(into.storage, into.key, fileOf(lines), now);
    expect(await records(into)).toEqual(await records(from));
  });

  test("round-trips a file whose monitors' records are interleaved", async () => {
    const from = await source();
    const into = await target();
    const [header = "", ...history] = await exportLines(from);
    const api = history.filter((line) => line.includes(from.ids.api));
    const rest = history.filter((line) => !line.includes(from.ids.api));
    const half = Math.floor(api.length / 2);
    const mixed = [header, ...api.slice(0, half), ...rest, ...api.slice(half)];
    expect(
      await importInstall(into.storage, into.key, fileOf(mixed), now)
    ).toMatchObject({ ok: true });
    expect(await records(into)).toEqual(await records(from));
  });

  test("refuses a configuration the database will not hold together, at its first line, and writes nothing", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from, "configuration");
    const header = JSON.parse(lines[0] ?? "{}");
    header.configuration.pageComponents[0].componentId = "no-such-component";
    expect(
      await importInstall(
        into.storage,
        into.key,
        fileOf([JSON.stringify(header)]),
        now
      )
    ).toEqual({ line: 1, ok: false, reason: "invalid" });
    expect(await empty(into)).toBe(true);
  });

  test("never writes a refused batch's values to the log, since they hold tokens and addresses", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from, "configuration");
    const header = JSON.parse(lines[0] ?? "{}");
    for (const row of header.configuration.subscriptions) {
      row.pageId = "no-such-page";
    }
    const token = String(header.configuration.subscriptions[0]?.token);
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    try {
      expect(
        await importInstall(
          into.storage,
          into.key,
          fileOf([JSON.stringify(header)]),
          now
        )
      ).toEqual({ line: 1, ok: false, reason: "invalid" });
    } finally {
      spy.mockRestore();
    }
    expect(written.join("")).toContain("constraint");
    expect(written.join("")).not.toContain(token);
    expect(written.join("")).not.toContain("visitor@example.test");
  });

  test("refuses a setting whose value does not fit the setting, at the header, and writes nothing", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from, "configuration");
    const header = JSON.parse(lines[0] ?? "{}");
    for (const row of header.configuration.settings) {
      if (row.key === "retention_days") {
        row.value = -1;
      }
    }
    expect(
      await importInstall(
        into.storage,
        into.key,
        fileOf([JSON.stringify(header)]),
        now
      )
    ).toEqual({ line: 1, ok: false, reason: "invalid" });
    expect(await empty(into)).toBe(true);
    expect(await into.storage.settings.get(installLanguage)).toBe("ar");
  });

  /** The configuration's header with its one page image's type and bytes replaced, and the image's page. */
  async function withImage(
    from: Install,
    contentType: string,
    body: Uint8Array
  ): Promise<{ header: string; pageId: string }> {
    const header = JSON.parse(
      (await exportLines(from, "configuration"))[0] ?? "{}"
    );
    const [image] = header.configuration.pageImages;
    image.contentType = contentType;
    image.body = body.toBase64();
    return { header: JSON.stringify(header), pageId: image.pageId };
  }

  const pngBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test("takes a page image for what its bytes say, never the type or hash the file names, and serves it under its sandbox policy", async () => {
    const from = await source();
    const into = await target();
    const png = new Uint8Array([...pngBytes, 9, 9, 9]);
    const { header, pageId } = await withImage(from, "text/html", png);
    const lines = JSON.parse(header);
    lines.configuration.pageImages[0].hash = "not-its-hash";
    expect(
      (
        await importInstall(
          into.storage,
          into.key,
          fileOf([JSON.stringify(lines)]),
          now
        )
      ).ok
    ).toBe(true);
    const served = await pageImageResponse(
      into.storage,
      pageId,
      "logo",
      new Request("http://status.example.test/"),
      () => Promise.resolve(false)
    );
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-security-policy")).toBe(imagePolicy);
    expect(served.headers.get("etag")).toBe(
      `"${new Bun.CryptoHasher("sha256").update(png).digest("hex")}"`
    );
  });

  test("refuses a page image whose bytes are no image of its kind, such as HTML with a script, at the header, and writes nothing", async () => {
    const from = await source();
    const into = await target();
    const { header, pageId } = await withImage(
      from,
      "text/html",
      new TextEncoder().encode(
        "<!doctype html><script>fetch('/admin/monitors')</script>"
      )
    );
    expect(
      await importInstall(into.storage, into.key, fileOf([header]), now)
    ).toEqual({ line: 1, ok: false, reason: "invalid" });
    expect(await empty(into)).toBe(true);
    const served = await pageImageResponse(
      into.storage,
      pageId,
      "logo",
      new Request("http://status.example.test/"),
      () => Promise.resolve(true)
    );
    expect(served.status).toBe(404);
  });

  test("refuses a page image larger than an upload of its kind may be, at the header", async () => {
    const from = await source();
    const into = await target();
    const large = new Uint8Array(pageImageMaxBytes.logo + 1);
    large.set(pngBytes);
    const { header } = await withImage(from, "image/png", large);
    expect(
      await importInstall(into.storage, into.key, fileOf([header]), now)
    ).toEqual({ line: 1, ok: false, reason: "invalid" });
    expect(await empty(into)).toBe(true);
  });

  test("refuses a line past 8 MB as too large to read, by its number, and writes nothing", async () => {
    const into = await target();
    expect(
      await importInstall(
        into.storage,
        into.key,
        fileOf(["x".repeat(8 * 1024 * 1024 + 1)]),
        now
      )
    ).toEqual({ line: 1, ok: false, reason: "line_too_large" });
    expect(await empty(into)).toBe(true);
  });

  test("takes a header as large as a real one comes: a page's three images at their size limits", async () => {
    const from = await source();
    const into = await target();
    const header = JSON.parse(
      (await exportLines(from, "configuration"))[0] ?? "{}"
    );
    const { pageId } = header.configuration.pageImages[0];
    for (const kind of pageImageKinds) {
      const body = new Uint8Array(pageImageMaxBytes[kind]);
      body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // biome-ignore lint/performance/noAwaitInLoops: three writes, one after another
      await from.storage.pages.setImage(pageId, {
        body,
        contentType: "image/png",
        hash: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
        kind,
      });
    }
    expect(
      (
        await importInstall(
          into.storage,
          into.key,
          fileOf(await exportLines(from, "configuration")),
          now
        )
      ).ok
    ).toBe(true);
  });

  test("refuses a blank line among the records, by its number", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from);
    const broken = [...lines.slice(0, 3), "", ...lines.slice(3)];
    expect(
      await importInstall(into.storage, into.key, fileOf(broken), now)
    ).toEqual({ line: 4, ok: false, reason: "invalid" });
    expect(await empty(into)).toBe(true);
  });

  test("keeps a day's daily rollup as the file gives it when the file carries its hours too", async () => {
    const from = await source();
    const into = await target();
    const lines = await exportLines(from);
    const hourly = lines.findIndex(
      (line) =>
        line.includes('"kind":"hourly"') &&
        line.includes(new Date(today - 40 * day).toISOString())
    );
    const daily = JSON.stringify({
      at: new Date(today - 40 * day).toISOString(),
      averageMs: 999,
      checks: 1,
      degraded: 0,
      failed: 0,
      kind: "daily",
      maxMs: 999,
      minMs: 999,
      monitor: from.ids.api,
      observedMs: 1000,
    });
    const withDaily = [
      ...lines.slice(0, hourly),
      daily,
      ...lines.slice(hourly),
    ];
    await importInstall(into.storage, into.key, fileOf(withDaily), now);
    expect(
      await into.storage.checks.rollups(
        from.ids.api,
        "day",
        today - 40 * day,
        today - 39 * day
      )
    ).toMatchObject([{ averageMs: 999, checks: 1 }]);
  });

  test("hands storage at most a batch of records at a time, so the history never sits in memory", async () => {
    const from = await source();
    const into = await target();
    await checksEvery(
      from.storage,
      from.ids.dns,
      today - day,
      today - day + 1300 * minute,
      minute
    );
    const sizes: number[] = [];
    const write = into.storage.transfer.writeChecks;
    const counting = {
      ...into.storage,
      transfer: {
        ...into.storage.transfer,
        writeChecks: (rows: Parameters<typeof write>[0]) => {
          sizes.push(rows.length);
          return write(rows);
        },
      },
    };
    await importInstall(
      counting,
      into.key,
      fileOf(await exportLines(from)),
      now
    );
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(1300);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
  });

  test("without a database is unavailable", async () => {
    const into = await target();
    expect(await importInstall(undefined, into.key, fileOf([]), now)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
