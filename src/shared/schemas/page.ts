/**
 * A status page's shapes (CONTEXT.md "Status page", "Component group",
 * "Page language"): its slug, title, page language, custom
 * domain, whether it is the default for the bare host, its customization,
 * the ordered component list with its groups, and its logo, favicon and
 * cover image. The customization is one JSON value parsed here, each key
 * with its default, so a key a later version adds reads as its default
 *. The page list and editor's views and results are
 * here too, so the admin never imports the server.
 */
import { z } from "zod";
import { type Locale, localeSchema } from "@/shared/i18n/locale.ts";
import { themeSchema } from "./appearance.ts";
import {
  type Content,
  contentSchema,
  optionalContentSchema,
  writtenIn,
} from "./content.ts";
import { type StatusLevel, statusLevelSchema } from "./status.ts";

export const pageTitleMaxLength = 100;
export const pageDescriptionMaxLength = 500;
export const groupNameMaxLength = 100;
export const statusLabelMaxLength = 40;
export const footerLinksMax = 10;
export const footerLabelMaxLength = 40;
/** Custom CSS in UTF-8 bytes. */
export const customCssMaxBytes = 65_536;

/** The day bar's lengths a page may choose. */
export const barLengths = [30, 60, 90] as const;
export type BarLength = (typeof barLengths)[number];

/** The subscription channels a page may offer. */
export const subscriptionChannels = ["email", "webhook"] as const;
export type SubscriptionChannel = (typeof subscriptionChannels)[number];

/** A slug: lower-case letters, digits and dashes, 1 to 63, no dash at either end. */
export const pageSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const pageSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(pageSlugPattern);

const trailingDot = /\.$/;
/** A scheme, a path, a port, a query, a user or an IPv6 address each need one of these. */
const notInDomain = /[\s/:?#@[\]\\]/;
const digitsOnly = /^\d+$/;
/** A DNS label a host can hold: letters, digits and inner dashes, up to 63; an internationalized one is its ASCII form by then. */
const hostLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A custom domain as a page stores it and a request's host is matched
 * against it: lower case, no port, no trailing dot, an
 * internationalized name as its ASCII form through the URL parser. A
 * scheme, a path, a port, an address or a name without a dot is not one.
 */
export function customDomainOf(text: string): string | undefined {
  const typed = text.trim().toLowerCase().replace(trailingDot, "");
  if (typed === "" || notInDomain.test(typed)) {
    return;
  }
  let host: string;
  try {
    host = new URL(`http://${typed}`).hostname;
  } catch {
    return;
  }
  const labels = host.split(".");
  const last = labels.at(-1) ?? "";
  // A last label of digits is an address, which the URL parser has already normalized.
  if (
    labels.length < 2 ||
    host.length > 253 ||
    labels.some((label) => !hostLabel.test(label)) ||
    digitsOnly.test(last)
  ) {
    return;
  }
  return host;
}

export const customDomainSchema = z.string().transform((text, context) => {
  const domain = customDomainOf(text);
  if (domain === undefined) {
    context.addIssue({ code: "custom", message: "a domain name" });
    return z.NEVER;
  }
  return domain;
});

/** A colour as `#rrggbb`, lower case. */
export const colourSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/);

/** Where a visitor's link goes: an http or https URL, or a mailto address. */
export function isVisitorLink(text: string): boolean {
  if (!URL.canParse(text)) {
    return false;
  }
  const url = new URL(text);
  if (url.protocol === "mailto:") {
    return url.pathname !== "";
  }
  // The URL parser refuses an http or https URL with no host.
  return url.protocol === "https:" || url.protocol === "http:";
}

export const visitorLinkSchema = z
  .string()
  .trim()
  .refine((text) => isVisitorLink(text), "an https, http or mailto link");

export const footerLinkSchema = z.object({
  label: contentSchema(footerLabelMaxLength),
  url: visitorLinkSchema,
});
export type FooterLink = z.infer<typeof footerLinkSchema>;

/** True when the custom CSS fits its cap and cannot end the style element it is written into. */
export function isCustomCss(text: string): boolean {
  return (
    new TextEncoder().encode(text).length <= customCssMaxBytes &&
    !text.includes("</")
  );
}

/** Everything a page customizes beyond its slug, title, language and domain. */
export const pageCustomizationSchema = z.object({
  /** The day bar on the public page, and how many days it spans. */
  barDays: z.union(barLengths.map((days) => z.literal(days))).default(90),
  bars: z.boolean().default(true),
  brandColour: colourSchema.optional(),
  contactUrl: visitorLinkSchema.optional(),
  customCss: z
    .string()
    .refine((text) => isCustomCss(text))
    .optional(),
  description: optionalContentSchema(pageDescriptionMaxLength),
  footerLinks: z.array(footerLinkSchema).max(footerLinksMax).default([]),
  /** A display label per status level in each locale; the machine value never changes. */
  labels: z
    .partialRecord(statusLevelSchema, contentSchema(statusLabelMaxLength))
    .default({}),
  noindex: z.boolean().default(false),
  percentages: z.boolean().default(true),
  poweredBy: z.boolean().default(true),
  statusColours: z.partialRecord(statusLevelSchema, colourSchema).default({}),
  subscriptions: z
    .array(z.enum(subscriptionChannels))
    .transform((channels) => [...new Set(channels)])
    .default([...subscriptionChannels]),
  /** The theme a visitor's browser falls back to with no choice of its own (ADR-0006). */
  theme: themeSchema.default("system"),
});
export type PageCustomization = z.infer<typeof pageCustomizationSchema>;

/** The colours a level shows until the page picks its own: the design language's light ones. */
export const defaultStatusColours: Readonly<Record<StatusLevel, string>> = {
  degraded_performance: "#d97706",
  major_outage: "#dc2626",
  operational: "#16a34a",
  partial_outage: "#ea580c",
  under_maintenance: "#2563eb",
};

/** A new page's customization: every key at its default. */
export const defaultCustomization: PageCustomization =
  pageCustomizationSchema.parse({});

/** One entry of a page's ordered component list: a component, or a group of them one level deep. */
export type PageItem =
  | { readonly kind: "component"; readonly componentId: string }
  | {
      readonly kind: "group";
      readonly componentIds: readonly string[];
      readonly name: Content;
    };

/** A page's components in order, groups and ungrouped components sharing one top-level order. */
export type PageLayout = readonly PageItem[];

/** The components a layout shows, in its order. */
export function componentsOf(layout: PageLayout): string[] {
  return layout.flatMap((item) =>
    item.kind === "component" ? [item.componentId] : [...item.componentIds]
  );
}

export const pageLayoutSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.object({
        componentId: z.string().min(1),
        kind: z.literal("component"),
      }),
      z.object({
        componentIds: z.array(z.string().min(1)),
        kind: z.literal("group"),
        name: contentSchema(groupNameMaxLength),
      }),
    ])
  )
  .refine(
    (layout) => {
      const shown = componentsOf(layout);
      return new Set(shown).size === shown.length;
    },
    { message: "a component appears once" }
  );

export interface StatusPageFields {
  readonly customDomain: string | undefined;
  readonly customization: PageCustomization;
  /** Served at the bare host; at most one page is. */
  readonly isDefault: boolean;
  readonly locale: Locale;
  /** Public only once published: an unpublished page is a visitor's not-found everywhere. */
  readonly published: boolean;
  readonly slug: string;
  readonly title: Content;
}

export interface StatusPage extends StatusPageFields {
  readonly createdAt: number;
  readonly id: string;
  readonly updatedAt: number;
}

/** A new page: its title in the page language; the rest, the other locale's title too, starts at its defaults and is edited on the page's editor. */
export const pageCreateSchema = z.object({
  locale: localeSchema,
  slug: pageSlugSchema,
  title: z.string().trim().min(1).max(pageTitleMaxLength),
});
export type PageCreateInput = z.infer<typeof pageCreateSchema>;

/** A page as the editor saves it; its title, description, footer link labels and group names hold the page language's text. A status name may be written in any locale alone: one without a name shows the catalog's word. */
export const pageInputSchema = z
  .object({
    customDomain: customDomainSchema.optional(),
    customization: pageCustomizationSchema,
    isDefault: z.boolean(),
    layout: pageLayoutSchema,
    locale: localeSchema,
    published: z.boolean(),
    slug: pageSlugSchema,
    title: contentSchema(pageTitleMaxLength),
  })
  .superRefine((input, context) => {
    const required = (
      path: (string | number)[],
      content: Content | undefined
    ) => {
      if (!writtenIn(input.locale, content)) {
        context.addIssue({
          code: "custom",
          message: "the page language's text",
          path,
        });
      }
    };
    const { customization } = input;
    required(["title"], input.title);
    required(["customization", "description"], customization.description);
    for (const [row, link] of customization.footerLinks.entries()) {
      required(["customization", "footerLinks", row, "label"], link.label);
    }
    for (const [index, item] of input.layout.entries()) {
      if (item.kind === "group") {
        required(["layout", index, "name"], item.name);
      }
    }
  });
export type PageInput = z.infer<typeof pageInputSchema>;

export const pageEditSchema = z.object({
  id: z.string().min(1),
  input: pageInputSchema,
});

export const pageIdSchema = z.object({ id: z.string().min(1) });

/** A page's images. */
export const pageImageKinds = ["logo", "favicon", "cover"] as const;
export const pageImageKindSchema = z.enum(pageImageKinds);
export type PageImageKind = z.infer<typeof pageImageKindSchema>;

/** The largest file each image may be. */
export const pageImageMaxBytes: Readonly<Record<PageImageKind, number>> = {
  cover: 1_048_576,
  favicon: 262_144,
  logo: 262_144,
};

/** A stored image as the editor and the public page know it, without its bytes. */
export interface PageImage {
  readonly contentType: string;
  /** The SHA-256 of its bytes in hex; the URL carries it, so a new image is a new URL. */
  readonly hash: string;
  readonly kind: PageImageKind;
}

/** Where a visitor's browser fetches the image, on any host that serves the page. */
export function pageImageUrl(pageId: string, image: PageImage): string {
  return `/api/pages/${encodeURIComponent(pageId)}/${image.kind}?v=${image.hash}`;
}

/** An image upload's form: the page's id, the image's kind and the file. */
export interface PageImageUpload {
  readonly file: Blob;
  readonly id: string;
  readonly kind: PageImageKind;
}

/** Reads an upload's form data at the parse boundary; throws on a malformed one, as a Zod validator does. */
export function pageImageUploadOf(data: unknown): PageImageUpload {
  if (!(data instanceof FormData)) {
    throw new TypeError("an image upload is form data");
  }
  const id = data.get("id");
  const file = data.get("file");
  if (typeof id !== "string" || id === "" || !(file instanceof Blob)) {
    throw new TypeError("an image upload names its page and carries a file");
  }
  return { file, id, kind: pageImageKindSchema.parse(data.get("kind")) };
}

export const pageImageRemoveSchema = z.object({
  id: z.string().min(1),
  kind: pageImageKindSchema,
});

/** One page as the list shows it. */
export interface PageListItem {
  readonly components: number;
  /** Its status level now: the worst of the components it shows. */
  readonly level: StatusLevel;
  readonly page: StatusPage;
}

/** A component the editor can place, with its status now. */
export interface PlaceableComponent {
  readonly id: string;
  readonly name: Content;
  readonly status: StatusLevel;
}

/** What the page editor reads. */
export interface PageEditor {
  /** Every component of the install, in creation order. */
  readonly components: readonly PlaceableComponent[];
  readonly images: readonly PageImage[];
  readonly layout: PageLayout;
  readonly page: StatusPage;
  /** Each status level's own name in every locale: what a page shows where it names a level nothing of its own. */
  readonly statusNames: Readonly<
    Record<Locale, Readonly<Record<StatusLevel, string>>>
  >;
}

export type PageRefusal =
  | "invalid"
  | "not_found"
  | "unavailable"
  /** Another page has the slug. */
  | "slug_taken"
  /** Another page has the custom domain. */
  | "domain_taken"
  /** The custom domain is the public address's host, which serves the admin and the default page. */
  | "domain_public_address";

export type PageListResult =
  | { readonly ok: true; readonly pages: readonly PageListItem[] }
  | { readonly ok: false; readonly reason: "unavailable" }
  /** A stored record this version cannot read; `id` names it. */
  | { readonly ok: false; readonly reason: "corrupt"; readonly id: string };

export type PageEditorResult =
  | { readonly ok: true; readonly editor: PageEditor }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" }
  | { readonly ok: false; readonly reason: "corrupt"; readonly id: string };

export type PageSaveResult =
  | { readonly ok: true; readonly page: StatusPage }
  | { readonly ok: false; readonly reason: PageRefusal };

export type PageDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" };

export type PageImageRefusal =
  /** Not a PNG, JPEG, WebP or SVG (or an ICO, for a favicon). */
  "invalid" | "not_found" | "too_large" | "unavailable";

export type PageImageResult =
  | { readonly ok: true; readonly image: PageImage | undefined }
  | { readonly ok: false; readonly reason: PageImageRefusal };
