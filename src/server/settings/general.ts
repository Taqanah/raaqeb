/**
 * The general settings page: the install language,
 * time zone, clock format, calendar, public address, the trusted proxies (managed by
 * environment when `RAAQEB_TRUSTED_PROXIES` is set), the release check
 * switch and the request log switch, plus the database backend as a read-only row, managed by
 * environment when `DATABASE_URL` is set. Every function answers a result
 * and never throws.
 */

import { isProxyEntry } from "@/server/boot/proxies.ts";
import type { BootSettings } from "@/server/boot/settings.ts";
import { releaseCheckEnabled } from "@/server/release/release.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { hostTimeZone, timeZones } from "@/shared/i18n/timezone.ts";
import { customDomainOf } from "@/shared/schemas/page.ts";
import type {
  GeneralSaveResult,
  GeneralSettings,
  GeneralSettingsInput,
} from "@/shared/schemas/settings.ts";
import { publicAddress } from "./address.ts";
import { calendar, clock, readClock, readSetting, timeZone } from "./clock.ts";
import { installLanguage, readInstallLanguage } from "./language.ts";
import { operatorLanguage } from "./operator.ts";
import { trustedProxies } from "./proxies.ts";
import { requestLogEnabled } from "./request-log.ts";

export async function readGeneralSettings(
  storage: Pick<Storage, "backend" | "settings">,
  boot: Pick<BootSettings, "databaseUrlFromEnvironment" | "trustedProxies">
): Promise<GeneralSettings> {
  const managed = boot.trustedProxies.length > 0;
  const [
    language,
    ownLanguage,
    clockSettings,
    address,
    releaseCheck,
    requestLog,
    proxies,
  ] = await Promise.all([
    readInstallLanguage(storage),
    readSetting<Locale | undefined>(storage, operatorLanguage, undefined),
    readClock(storage),
    readSetting(storage, publicAddress, ""),
    readSetting(storage, releaseCheckEnabled, true),
    readSetting(storage, requestLogEnabled, false),
    managed ? boot.trustedProxies : readSetting(storage, trustedProxies, []),
  ]);
  return {
    calendar: clockSettings.calendar,
    clock: clockSettings.clock,
    database: {
      // The open storage, not the boot settings: onboarding may choose Postgres after boot.
      backend: storage.backend,
      managedByEnvironment: boot.databaseUrlFromEnvironment,
    },
    hostTimeZone: hostTimeZone(),
    installLanguage: language,
    operatorLanguage: ownLanguage,
    publicAddress: address,
    releaseCheck,
    requestLog,
    timeZone: clockSettings.timeZone,
    timeZones: timeZones(),
    // The variable wins where it is set.
    trustedProxies: { entries: proxies, managedByEnvironment: managed },
  };
}

/**
 * Stores the public address alone and moves the change counter, under the
 * general page's rule: refused when a status page serves its host as its
 * custom domain. The `set-address` command's write;
 * Better Auth's instance, the scheduler and the public memo each read the
 * address again on their next use, so a running server needs no restart.
 */
export async function savePublicAddress(
  storage: Pick<Storage, "bump" | "pages" | "settings">,
  address: string
): Promise<GeneralSaveResult> {
  try {
    if (await servedAsPageDomain(storage, address)) {
      return { ok: false, reason: "address_is_page_domain" };
    }
    await storage.settings.set(publicAddress, address);
    await storage.bump();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Whether a status page serves the address's host as its custom domain, which the public address never is, from either side. */
async function servedAsPageDomain(
  storage: Pick<Storage, "pages">,
  address: string
): Promise<boolean> {
  // The address's host in a domain's own form, so a trailing dot names the same host.
  const host = customDomainOf(new URL(address).hostname);
  const pages = await storage.pages.list();
  return host !== undefined && pages.some((page) => page.customDomain === host);
}

/** Stores the general settings and moves the change counter: the time zone reads a heartbeat monitor's cron schedule and renders every public timestamp, and the entry reads the trusted proxies and the request log switch again when it moves. Trusted proxies left out keep the stored ones; while `RAAQEB_TRUSTED_PROXIES` manages them, any the save carries are ignored, so the lock holds on the server and not in the form alone. */
export async function saveGeneralSettings(
  storage: Pick<Storage, "bump" | "pages" | "settings">,
  input: GeneralSettingsInput,
  boot: Pick<BootSettings, "trustedProxies">
): Promise<GeneralSaveResult> {
  const proxies =
    boot.trustedProxies.length > 0 ? undefined : input.trustedProxies;
  // The variable's rule, judged before anything is written.
  if (proxies?.some((entry) => !isProxyEntry(entry))) {
    return { ok: false, reason: "trusted_proxy_invalid" };
  }
  try {
    if (await servedAsPageDomain(storage, input.publicAddress)) {
      return { ok: false, reason: "address_is_page_domain" };
    }
    await storage.settings.set(installLanguage, input.installLanguage);
    await storage.settings.set(timeZone, input.timeZone);
    await storage.settings.set(clock, input.clock);
    await storage.settings.set(calendar, input.calendar);
    await storage.settings.set(publicAddress, input.publicAddress);
    await storage.settings.set(releaseCheckEnabled, input.releaseCheck);
    await storage.settings.set(requestLogEnabled, input.requestLog);
    if (proxies !== undefined) {
      await storage.settings.set(trustedProxies, proxies);
    }
    await storage.bump();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
