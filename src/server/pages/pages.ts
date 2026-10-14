/**
 * The status pages module (CONTEXT.md "Status page", "Component group"):
 * what the admin's server functions call to list pages,
 * read one page's editor, create, save and delete. A new page starts with
 * the defaults, unpublished, and becomes the default page when the
 * install has none; a save publishes or unpublishes
 * it. A save refuses a slug or a custom domain another
 * page has, and a custom domain that is the public address's host. Every
 * write moves the change counter. Every function answers a
 * result and never throws.
 */

import { readPublicAddress } from "@/server/settings/address.ts";
import { loadCatalog } from "@/server/settings/language.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { worstStatus } from "@/shared/domain/status.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import {
  customDomainOf,
  defaultCustomization,
  type PageCreateInput,
  type PageDeleteResult,
  type PageEditor,
  type PageEditorResult,
  type PageInput,
  type PageListResult,
  type PageRefusal,
  type PageSaveResult,
} from "@/shared/schemas/page.ts";
import { corruptRecord, readComponentStatuses } from "./components.ts";

export type PageStorage = Pick<
  Storage,
  | "bump"
  | "checks"
  | "components"
  | "incidents"
  | "maintenance"
  | "monitors"
  | "outages"
  | "pages"
  | "settings"
>;

const unavailable = { ok: false, reason: "unavailable" } as const;
const notFound = { ok: false, reason: "not_found" } as const;

/** A failed read's result: the record this version cannot read, or unavailable. */
function failedRead(
  error: unknown
):
  | { readonly ok: false; readonly reason: "unavailable" }
  | { readonly ok: false; readonly reason: "corrupt"; readonly id: string } {
  const id = corruptRecord(error);
  return id === undefined ? unavailable : { id, ok: false, reason: "corrupt" };
}

/** The list: every page with its status level now and how many components it shows. */
export async function listPages(storage: PageStorage): Promise<PageListResult> {
  try {
    const [pages, shown, { statuses }] = await Promise.all([
      storage.pages.list(),
      storage.pages.componentsShown(),
      readComponentStatuses(storage),
    ]);
    return {
      ok: true,
      pages: pages.map((page) => {
        const ids = shown.get(page.id) ?? [];
        return {
          components: ids.length,
          level: worstStatus(
            ids.map((id) => statuses.get(id) ?? "operational")
          ),
          page,
        };
      }),
    };
  } catch (error) {
    return failedRead(error);
  }
}

/** One locale's name of each status level. */
async function statusNamesIn(
  locale: Locale
): Promise<PageEditor["statusNames"][Locale]> {
  const messages = createMessages(locale, await loadCatalog(locale));
  return {
    degraded_performance: messages._("component_level_degraded_performance"),
    major_outage: messages._("component_level_major_outage"),
    operational: messages._("component_level_operational"),
    partial_outage: messages._("component_level_partial_outage"),
    under_maintenance: messages._("component_level_under_maintenance"),
  };
}

/** Each status level's own name in every locale, from the catalogs. */
async function statusNames(): Promise<PageEditor["statusNames"]> {
  const [ar, en] = await Promise.all([
    statusNamesIn("ar"),
    statusNamesIn("en"),
  ]);
  return { ar, en };
}

/** The editor's read: the page, its layout, its images, every component with its status now, and each status level's own name in every locale. */
export async function readPageEditor(
  storage: PageStorage,
  id: string
): Promise<PageEditorResult> {
  try {
    const page = await storage.pages.find(id);
    if (!page) {
      return notFound;
    }
    const [layout, images, { components, statuses }] = await Promise.all([
      storage.pages.layout(id),
      storage.pages.images(id),
      readComponentStatuses(storage),
    ]);
    return {
      editor: {
        components: components.map((component) => ({
          id: component.id,
          name: component.name,
          status: statuses.get(component.id) ?? component.status,
        })),
        images,
        layout,
        page,
        statusNames: await statusNames(),
      },
      ok: true,
    };
  } catch (error) {
    return failedRead(error);
  }
}

export async function createPage(
  storage: PageStorage,
  input: PageCreateInput
): Promise<PageSaveResult> {
  try {
    const pages = await storage.pages.list();
    if (pages.some((each) => each.slug === input.slug)) {
      return { ok: false, reason: "slug_taken" };
    }
    const page = await storage.pages.create({
      customDomain: undefined,
      customization: defaultCustomization,
      // The install's first page, or its first after the default was deleted, serves the bare host.
      isDefault: !pages.some((each) => each.isDefault),
      locale: input.locale,
      // Public only once the operator publishes it.
      published: false,
      slug: input.slug,
      title: { [input.locale]: input.title },
    });
    await storage.bump();
    return { ok: true, page };
  } catch {
    return unavailable;
  }
}

/** Replaces the page's fields, its customization and its layout. */
export async function savePage(
  storage: PageStorage,
  id: string,
  input: PageInput
): Promise<PageSaveResult> {
  try {
    const refusal = await refusalOf(storage, id, input);
    if (refusal) {
      return { ok: false, reason: refusal };
    }
    const page = await storage.pages.save(
      id,
      {
        customDomain: input.customDomain,
        customization: input.customization,
        isDefault: input.isDefault,
        locale: input.locale,
        published: input.published,
        slug: input.slug,
        title: input.title,
      },
      input.layout
    );
    if (!page) {
      return notFound;
    }
    await storage.bump();
    return { ok: true, page };
  } catch {
    return unavailable;
  }
}

/** Why the save cannot go through: an unknown page, a slug or custom domain another page has, or the public address's own host as the custom domain. */
async function refusalOf(
  storage: PageStorage,
  id: string,
  input: PageInput
): Promise<PageRefusal | undefined> {
  const pages = await storage.pages.list();
  if (!pages.some((page) => page.id === id)) {
    return "not_found";
  }
  const others = pages.filter((page) => page.id !== id);
  if (others.some((page) => page.slug === input.slug)) {
    return "slug_taken";
  }
  const domain = input.customDomain;
  if (domain === undefined) {
    return;
  }
  if (others.some((page) => page.customDomain === domain)) {
    return "domain_taken";
  }
  const address = await readPublicAddress(storage);
  // The address's host in a domain's own form, so a trailing dot names the same host.
  if (
    address !== undefined &&
    customDomainOf(new URL(address).hostname) === domain
  ) {
    return "domain_public_address";
  }
}

/** Deletes the page with its layout and images. */
export async function deletePage(
  storage: PageStorage,
  id: string
): Promise<PageDeleteResult> {
  try {
    if (!(await storage.pages.remove(id))) {
      return notFound;
    }
    await storage.bump();
    return { ok: true };
  } catch {
    return unavailable;
  }
}
