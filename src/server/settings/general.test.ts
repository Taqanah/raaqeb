import { afterEach, describe, expect, test } from "bun:test";
import { releaseCheckEnabled } from "@/server/release/release.ts";
import { fixtureBackend, scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { hostTimeZone } from "@/shared/i18n/timezone.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { publicAddress } from "./address.ts";
import { calendar, clock, timeZone } from "./clock.ts";
import {
  readGeneralSettings,
  saveGeneralSettings,
  savePublicAddress,
} from "./general.ts";
import { installLanguage } from "./language.ts";
import { operatorLanguage } from "./operator.ts";
import { trustedProxies } from "./proxies.ts";
import { requestLogEnabled } from "./request-log.ts";

let open: { storage: Storage; cleanup: () => Promise<void> } | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = { cleanup: scratch.cleanup, storage: opened.storage };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

const boot = { databaseUrlFromEnvironment: false, trustedProxies: [] };
const input = {
  calendar: "hijri",
  clock: "24h",
  installLanguage: "en",
  publicAddress: "https://status.example.test",
  releaseCheck: false,
  requestLog: false,
  timeZone: "Asia/Riyadh",
} as const;

describe("the public address and the pages' custom domains", () => {
  test("a public address whose host a status page serves as its custom domain is refused", async () => {
    const store = await storage();
    await store.pages.create({
      customDomain: "status.example.test",
      customization: defaultCustomization,
      isDefault: false,
      published: true,
      locale: "ar",
      slug: "status",
      title: { ar: "حالة" },
    });
    expect(await saveGeneralSettings(store, input, boot)).toEqual({
      ok: false,
      reason: "address_is_page_domain",
    });
    expect(await store.settings.get(publicAddress)).toBeUndefined();
    // A trailing dot names the same host.
    expect(
      await saveGeneralSettings(
        store,
        {
          ...input,
          publicAddress: "https://status.example.test.",
        },
        boot
      )
    ).toEqual({ ok: false, reason: "address_is_page_domain" });
    expect(
      await saveGeneralSettings(
        store,
        {
          ...input,
          publicAddress: "https://admin.example.test",
        },
        boot
      )
    ).toEqual({ ok: true });
  });
});

describe("the general settings page", () => {
  test("a fresh install shows Arabic, the host zone, a 12-hour clock, no public address and the release check on", async () => {
    const store = await storage();
    const settings = await readGeneralSettings(store, boot);
    // The zone list comes from the server's ICU, so the document and the browser offer the same names.
    expect(settings.timeZones).toContain("Asia/Riyadh");
    const { timeZones: _zones, ...rest } = settings;
    expect(rest).toEqual({
      calendar: "gregorian",
      clock: "12h",
      database: { backend: fixtureBackend(), managedByEnvironment: false },
      hostTimeZone: hostTimeZone(),
      installLanguage: "ar",
      operatorLanguage: undefined,
      publicAddress: "",
      releaseCheck: true,
      requestLog: false,
      timeZone: hostTimeZone(),
      trustedProxies: { entries: [], managedByEnvironment: false },
    });
  });

  test("names the operator's own language, and nothing while it follows the install's", async () => {
    const store = await storage();
    expect((await readGeneralSettings(store, boot)).operatorLanguage).toBe(
      undefined
    );
    await store.settings.set(operatorLanguage, "en");
    expect((await readGeneralSettings(store, boot)).operatorLanguage).toBe(
      "en"
    );
  });

  test("every field round-trips through save and read", async () => {
    const store = await storage();
    expect(await saveGeneralSettings(store, input, boot)).toEqual({ ok: true });
    expect(await readGeneralSettings(store, boot)).toMatchObject(input);
  });

  test("saving writes the rows the rest of the install reads: the install language, the public address, the zone, the clock, the calendar and the switch", async () => {
    const store = await storage();
    await saveGeneralSettings(store, input, boot);
    expect(await store.settings.get(installLanguage)).toBe("en");
    expect(await store.settings.get(publicAddress)).toBe(
      "https://status.example.test"
    );
    expect(await store.settings.get(timeZone)).toBe("Asia/Riyadh");
    expect(await store.settings.get(clock)).toBe("24h");
    expect(await store.settings.get(calendar)).toBe("hijri");
    expect(await store.settings.get(releaseCheckEnabled)).toBe(false);
  });

  test("the request log switch is off until saved on, and the entry reads the row it is saved to", async () => {
    const store = await storage();
    expect((await readGeneralSettings(store, boot)).requestLog).toBe(false);
    await saveGeneralSettings(store, { ...input, requestLog: true }, boot);
    expect((await readGeneralSettings(store, boot)).requestLog).toBe(true);
    expect(await store.settings.get(requestLogEnabled)).toBe(true);
    await saveGeneralSettings(store, input, boot);
    expect((await readGeneralSettings(store, boot)).requestLog).toBe(false);
  });

  test("saving moves the change counter: the time zone reads a heartbeat monitor's cron schedule, so the scheduler reads the settings again", async () => {
    const store = await storage();
    const before = await store.changeCounter();
    await saveGeneralSettings(store, input, boot);
    expect(await store.changeCounter()).toBe(before + 1);
  });

  test("the database row names the backend and is managed by environment only when DATABASE_URL is set", async () => {
    const store = await storage();
    const postgres = { backend: "postgres", settings: store.settings } as const;
    const fromEnvironment = await readGeneralSettings(postgres, {
      databaseUrlFromEnvironment: true,
      trustedProxies: [],
    });
    expect(fromEnvironment.database).toEqual({
      backend: "postgres",
      managedByEnvironment: true,
    });
    // The boot settings name no URL here, as when onboarding chose Postgres: the open storage names the backend before a restart.
    const fromConfig = await readGeneralSettings(postgres, {
      databaseUrlFromEnvironment: false,
      trustedProxies: [],
    });
    expect(fromConfig.database).toEqual({
      backend: "postgres",
      managedByEnvironment: false,
    });
  });

  test("a database that stops answering is reported as unavailable, never thrown, and reading answers the defaults", async () => {
    const store = await storage();
    await store.close();
    expect(await saveGeneralSettings(store, input, boot)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect((await readGeneralSettings(store, boot)).installLanguage).toBe("ar");
  });
});

describe("the trusted proxies on the general page", () => {
  test("addresses and CIDR ranges, IPv4 and IPv6, are stored and read back as the entries in force", async () => {
    const store = await storage();
    const entries = ["10.0.0.1", "172.16.0.0/12", "fd00::/8", "::1"];
    expect(
      await saveGeneralSettings(
        store,
        { ...input, trustedProxies: entries },
        boot
      )
    ).toEqual({ ok: true });
    expect(await store.settings.get(trustedProxies)).toEqual(entries);
    expect((await readGeneralSettings(store, boot)).trustedProxies).toEqual({
      entries,
      managedByEnvironment: false,
    });
  });

  test("an entry that is not an IP address or a CIDR range refuses the save, by the variable's rule, and writes nothing", async () => {
    const store = await storage();
    const before = await store.changeCounter();
    for (const bad of [
      "proxy.internal",
      "10.0.0.256",
      "10.0.0.0/33",
      "fd00::/129",
      "10.0.0.1/8/8",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one refusal at a time, each against the same empty row
      const saved = await saveGeneralSettings(
        store,
        {
          ...input,
          trustedProxies: ["10.0.0.1", bad],
        },
        boot
      );
      expect(saved, bad).toEqual({
        ok: false,
        reason: "trusted_proxy_invalid",
      });
    }
    expect(await store.settings.get(trustedProxies)).toBeUndefined();
    expect(await store.settings.get(publicAddress)).toBeUndefined();
    expect(await store.changeCounter()).toBe(before);
  });

  test("an empty list is stored as none, so no forwarded header is believed", async () => {
    const store = await storage();
    await saveGeneralSettings(
      store,
      {
        ...input,
        trustedProxies: ["10.0.0.1"],
      },
      boot
    );
    await saveGeneralSettings(store, { ...input, trustedProxies: [] }, boot);
    expect(await store.settings.get(trustedProxies)).toEqual([]);
  });

  test("a save without the field, as the page sends it while the variable manages it, keeps the stored entries", async () => {
    const store = await storage();
    await saveGeneralSettings(
      store,
      {
        ...input,
        trustedProxies: ["10.0.0.1"],
      },
      boot
    );
    expect(await saveGeneralSettings(store, input, boot)).toEqual({ ok: true });
    expect(await store.settings.get(trustedProxies)).toEqual(["10.0.0.1"]);
  });

  test("with RAAQEB_TRUSTED_PROXIES set, the field shows the variable's entries, managed by environment, over any stored ones", async () => {
    const store = await storage();
    await store.settings.set(trustedProxies, ["10.0.0.1"]);
    const settings = await readGeneralSettings(store, {
      databaseUrlFromEnvironment: false,
      trustedProxies: ["172.31.253.2"],
    });
    expect(settings.trustedProxies).toEqual({
      entries: ["172.31.253.2"],
      managedByEnvironment: true,
    });
  });

  test("while RAAQEB_TRUSTED_PROXIES manages the field, a save that carries trusted proxies leaves the stored ones untouched and saves the rest", async () => {
    const store = await storage();
    await store.settings.set(trustedProxies, ["10.0.0.1"]);
    const managed = { trustedProxies: ["172.31.253.2"] };
    expect(
      await saveGeneralSettings(
        store,
        { ...input, trustedProxies: ["0.0.0.0/0"] },
        managed
      )
    ).toEqual({ ok: true });
    expect(await store.settings.get(trustedProxies)).toEqual(["10.0.0.1"]);
    expect(await store.settings.get(clock)).toBe("24h");
    // Not judged either: the field is not the page's to save while the variable holds it.
    expect(
      await saveGeneralSettings(
        store,
        { ...input, trustedProxies: ["proxy.internal"] },
        managed
      )
    ).toEqual({ ok: true });
    expect(await store.settings.get(trustedProxies)).toEqual(["10.0.0.1"]);
  });
});

describe("the public address alone, as set-address stores it", () => {
  test("is stored and moves the change counter, so a running server reads it again", async () => {
    const store = await storage();
    const before = await store.changeCounter();
    expect(
      await savePublicAddress(store, "https://status.example.test")
    ).toEqual({ ok: true });
    expect(await store.settings.get(publicAddress)).toBe(
      "https://status.example.test"
    );
    expect(await store.changeCounter()).toBe(before + 1);
  });

  test("is refused, under the general page's rule, when a status page serves its host as its custom domain", async () => {
    const store = await storage();
    await store.settings.set(publicAddress, "http://status.example.test");
    await store.pages.create({
      customDomain: "status.example.test",
      customization: defaultCustomization,
      isDefault: false,
      published: true,
      locale: "ar",
      slug: "status",
      title: { ar: "حالة" },
    });
    expect(
      await savePublicAddress(store, "https://status.example.test")
    ).toEqual({ ok: false, reason: "address_is_page_domain" });
    expect(await store.settings.get(publicAddress)).toBe(
      "http://status.example.test"
    );
  });

  test("a database that stops answering is reported as unavailable, never thrown", async () => {
    const store = await storage();
    await store.close();
    expect(
      await savePublicAddress(store, "https://status.example.test")
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});
