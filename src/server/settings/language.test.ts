import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { defineSetting } from "@/server/storage/settings.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { isPublicMessage } from "@/shared/i18n/public.ts";
import {
  documentLanguage,
  installLanguage,
  loadCatalog,
  localeSwitchPaths,
  publicDocumentLanguage,
  readInstallLanguage,
  requestedLocale,
} from "./language.ts";

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

describe("the install language", () => {
  test("is a setting keyed install_language holding one of the two locales", () => {
    expect(installLanguage.key).toBe("install_language");
    expect(installLanguage.schema.parse("en")).toBe("en");
    expect(installLanguage.schema.safeParse("ar-SA").success).toBe(false);
  });

  test("is Arabic before anything is stored, and before the database exists", async () => {
    expect(await readInstallLanguage(await storage())).toBe("ar");
    expect(await readInstallLanguage(undefined)).toBe("ar");
  });

  test("is what onboarding stored", async () => {
    const opened = await storage();
    await opened.settings.set(installLanguage, "en");
    expect(await readInstallLanguage(opened)).toBe("en");
  });
});

describe("the document language", () => {
  test("carries the locale, its direction and that locale's catalog only", async () => {
    const opened = await storage();
    await opened.settings.set(installLanguage, "en");
    const document = await documentLanguage(opened);
    expect(document.locale).toBe("en");
    expect(document.dir).toBe("ltr");
    expect(document.catalog.app_name).toEqual(["Raaqeb"]);
  });

  test("falls back to Arabic, right to left, with no database", async () => {
    const document = await documentLanguage(undefined);
    expect(document.locale).toBe("ar");
    expect(document.dir).toBe("rtl");
    expect(document.catalog.app_name).toEqual(["راقب"]);
  });

  test("a stored language that is not a locale falls back to Arabic and is reported by key, so the document still renders", async () => {
    const opened = await storage();
    // The same row written through a looser declaration, as an older binary might have.
    await opened.settings.set(
      defineSetting(installLanguage.key, z.string()),
      "ar-SA"
    );
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      expect(await readInstallLanguage(opened)).toBe("ar");
      expect((await documentLanguage(opened)).locale).toBe("ar");
    } finally {
      process.stderr.write = write;
    }
    expect(lines.join("")).toContain("install_language");
    expect(lines.join("")).not.toContain("ar-SA");
  });

  test("a document language carries the title of the install", async () => {
    const opened = await storage();
    await opened.settings.set(installLanguage, "en");
    expect((await documentLanguage(opened)).title).toBe("Raaqeb");
    expect((await documentLanguage(undefined)).title).toBe("راقب");
  });

  test("a catalog is the same object on every load", async () => {
    expect(await loadCatalog("ar")).toBe(await loadCatalog("ar"));
    expect(await loadCatalog("en")).not.toBe(await loadCatalog("ar"));
  });
});

describe("a document in the locale the request asked for", () => {
  test("the sign-in, sign-out, recovery and onboarding pages may ask; the admin area may not", () => {
    expect(localeSwitchPaths).toEqual([
      "/sign-in",
      "/sign-out",
      "/forgot-password",
      "/reset-password",
      "/onboarding",
      "/onboarding/database",
      "/onboarding/account",
    ]);
    expect(requestedLocale("/sign-in", { locale: "en" })).toBe("en");
    expect(requestedLocale("/sign-out", { locale: "ar" })).toBe("ar");
    expect(requestedLocale("/onboarding", { locale: "en" })).toBe("en");
    expect(requestedLocale("/onboarding/database", { locale: "en" })).toBe(
      "en"
    );
    expect(requestedLocale("/onboarding/account", { locale: "en" })).toBe("en");
    expect(requestedLocale("/admin", { locale: "en" })).toBeUndefined();
    expect(requestedLocale("/", { locale: "en" })).toBeUndefined();
  });

  test("the general and account settings pages may preview the other locale through ?locale=, no other admin page", () => {
    expect(requestedLocale("/admin/settings", { locale: "en" })).toBe("en");
    expect(requestedLocale("/admin/settings/account", { locale: "ar" })).toBe(
      "ar"
    );
    expect(
      requestedLocale("/admin/settings/appearance", { locale: "en" })
    ).toBeUndefined();
    expect(
      requestedLocale("/admin/monitors", { locale: "en" })
    ).toBeUndefined();
  });

  test("a value that is not one of the two locales asks for nothing", () => {
    expect(requestedLocale("/sign-in", { locale: "ar-SA" })).toBeUndefined();
    expect(requestedLocale("/sign-in", { locale: 1 })).toBeUndefined();
    expect(requestedLocale("/sign-in", {})).toBeUndefined();
  });

  test("the requested locale wins over the stored install language for that document", async () => {
    const store = await storage();
    await store.settings.set(installLanguage, "ar");
    const document = await documentLanguage(store, "en");
    expect(document.locale).toBe("en");
    expect(document.dir).toBe("ltr");
    expect(document.title).toBe("Raaqeb");
    expect(document.catalog.app_name).toEqual(["Raaqeb"]);
  });
});

describe("a status page's document", () => {
  test("inlines the locale it shows with its direction and only the public part of its catalog", async () => {
    const arabic = await publicDocumentLanguage("ar");
    expect(arabic.locale).toBe("ar");
    expect(arabic.dir).toBe("rtl");
    expect(Object.keys(arabic.catalog).every(isPublicMessage)).toBe(true);
    expect(arabic.catalog.public_banner_operational).toBeDefined();
    expect(arabic.catalog.monitor_status_up).toBeUndefined();
    const english = await publicDocumentLanguage("en");
    expect(english.dir).toBe("ltr");
    expect(english.catalog.public_banner_operational).toEqual(
      (await loadCatalog("en")).public_banner_operational
    );
  });
});
