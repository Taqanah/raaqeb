/**
 * The install language (CONTEXT.md "Install language"): the locale
 * chosen on the onboarding page, Arabic by default, stored as a setting. This
 * module also answers what the server-rendered document needs for its first
 * paint: the locale, the reading direction and that locale's compiled catalog,
 * loaded on demand so the other locale never leaves the server.
 */

import { error as logError } from "@/server/log.ts";
import { defineSetting, type Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  type Direction,
  defaultLocale,
  directionOf,
  isLocale,
  type Locale,
  localeSchema,
} from "@/shared/i18n/locale.ts";
import { type Catalog, createMessages } from "@/shared/i18n/messages.ts";
import { publicCatalog } from "@/shared/i18n/public.ts";
import { type Content, writtenIn } from "@/shared/schemas/content.ts";

export const installLanguage: Setting<Locale> = defineSetting(
  "install_language",
  localeSchema
);

export interface DocumentLanguage {
  readonly catalog: Catalog;
  readonly dir: Direction;
  readonly locale: Locale;
  /** The install's name in that locale, for the document title. */
  readonly title: string;
}

/**
 * The install language, or Arabic when nothing is stored or no database is
 * open yet. A stored value that is not a locale is reported by key and
 * answered as Arabic too: the document must render so the setting can be
 * repaired, and a root loader that throws blanks every route.
 */
export async function readInstallLanguage(
  storage: Pick<Storage, "settings"> | undefined
): Promise<Locale> {
  try {
    return (await storage?.settings.get(installLanguage)) ?? defaultLocale;
  } catch {
    logError(
      `the stored setting ${installLanguage.key} is not a locale; using ${defaultLocale} until it is set again`
    );
    return defaultLocale;
  }
}

/** Whether each piece of install-wide content (a component's, an incident's, a maintenance window's) holds the install language's text, which a save requires. */
export async function inInstallLanguage(
  storage: Pick<Storage, "settings">,
  ...contents: readonly (Content | undefined)[]
): Promise<boolean> {
  return writtenIn(await readInstallLanguage(storage), ...contents);
}

// One dynamic import per locale: the module cache makes a catalog load once,
// and the client bundle never sees either file.
const catalogs: Readonly<Record<Locale, () => Promise<{ messages: Catalog }>>> =
  {
    ar: () => import("../../../locales/ar/messages.ts"),
    en: () => import("../../../locales/en/messages.ts"),
  };

/** The compiled catalog of one locale, loaded once. */
export async function loadCatalog(locale: Locale): Promise<Catalog> {
  return (await catalogs[locale]()).messages;
}

/**
 * The paths whose language switcher may override the install language for
 * one document through `?locale=`: the sign-in, sign-out and
 * recovery pages and the three onboarding screens. The admin area has no locale in
 * its URL.
 */
export const localeSwitchPaths: readonly string[] = [
  "/sign-in",
  "/sign-out",
  "/forgot-password",
  "/reset-password",
  "/onboarding",
  "/onboarding/database",
  "/onboarding/account",
];

/** The settings pages that preview a language before it is saved: picking one renders the page in it through ?locale=, and leaving drops it. */
export const localePreviewPaths: readonly string[] = [
  "/admin/settings",
  "/admin/settings/account",
];

/** The locale a request asks for, when its path may ask and its `locale` search value is one of the two. */
export function requestedLocale(
  pathname: string,
  search: unknown
): Locale | undefined {
  if (
    !(
      localeSwitchPaths.includes(pathname) ||
      localePreviewPaths.includes(pathname)
    )
  ) {
    return;
  }
  const locale =
    typeof search === "object" && search !== null && "locale" in search
      ? search.locale
      : undefined;
  return isLocale(locale) ? locale : undefined;
}

/** What the root document inlines: the install language (or the locale the request asked for), its direction and its catalog. */
export async function documentLanguage(
  storage: Pick<Storage, "settings"> | undefined,
  requested?: Locale
): Promise<DocumentLanguage> {
  const locale = requested ?? (await readInstallLanguage(storage));
  const catalog = await loadCatalog(locale);
  return {
    catalog,
    dir: directionOf(locale),
    locale,
    title: createMessages(locale, catalog)._("app_name"),
  };
}

/** What a status page's document inlines: the locale the request shows, its direction and the public part of its catalog; the page's own title stands in for the install's. */
export async function publicDocumentLanguage(
  locale: Locale
): Promise<Omit<DocumentLanguage, "title">> {
  return {
    catalog: publicCatalog(await loadCatalog(locale)),
    dir: directionOf(locale),
    locale,
  };
}
