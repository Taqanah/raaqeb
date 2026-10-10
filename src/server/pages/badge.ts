/**
 * A status page's SVG badge: a pill with a dot in
 * the page level's colour and the level's name in the address's locale, or
 * the page's own name for the level in that locale, and the page's title in
 * that locale or else the page language. Neutral ground and ink, so it reads on
 * any site that embeds it; the page's status colour colours the dot only.
 * An embedded SVG loads no font, so the text is fitted to a box its length
 * estimates. Reads never throw.
 */

import { loadCatalog } from "@/server/settings/language.ts";
import { statusNamesIn, worstStatus } from "@/shared/domain/status.ts";
import { directionOf, type Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { contentIn } from "@/shared/schemas/content.ts";
import { componentsOf, defaultStatusColours } from "@/shared/schemas/page.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";
import { readComponentStatuses } from "./components.ts";
import { imagePolicy } from "./images.ts";
import type { OverviewStorage } from "./overview.ts";
import { publicResponse, type ViewResult, xmlText } from "./views.ts";

export type BadgeStorage = OverviewStorage;

const height = 20;
const padding = 8;
const dotRadius = 3.5;
const gap = 6;
/** An 11 px glyph's average advance, in either script; `textLength` makes the text fill exactly the box it sizes. */
const glyphWidth = 6.5;

const fonts =
  "Rubik, 'Segoe UI', Tahoma, 'Noto Sans Arabic', 'DejaVu Sans', sans-serif";

/** The badge as SVG text: `title` names it for assistive technology, `label` is what it shows. */
function badgeSvg(
  title: string,
  label: string,
  colour: string,
  locale: Locale
): string {
  const direction = directionOf(locale);
  const textWidth = Math.ceil([...label].length * glyphWidth);
  const width = padding + 2 * dotRadius + gap + textWidth + padding;
  // The dot leads on the reading direction's start side.
  const dotX =
    direction === "rtl" ? width - padding - dotRadius : padding + dotRadius;
  const textStart =
    direction === "rtl" ? padding : padding + 2 * dotRadius + gap;
  const name = xmlText(`${title}: ${label}`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${name}">`,
    `<title>${name}</title>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="4.5" fill="#ffffff" stroke="#d4d4d8"/>`,
    `<circle cx="${dotX}" cy="${height / 2}" r="${dotRadius}" fill="${colour}"/>`,
    `<text x="${textStart + textWidth / 2}" y="14" text-anchor="middle" direction="${direction}" textLength="${textWidth}" lengthAdjust="spacingAndGlyphs" fill="#18181b" font-family="${fonts}" font-size="11" font-weight="500">${xmlText(label)}</text>`,
    "</svg>",
  ].join("");
}

/** The badge of the page with that id, in `locale`, as SVG text. */
export async function readBadge(
  storage: BadgeStorage,
  pageId: string,
  locale: Locale
): Promise<ViewResult<string>> {
  try {
    const page = await storage.pages.find(pageId);
    if (!page) {
      return { frame: undefined, ok: false, reason: "not_found" };
    }
    const [layout, { components, statuses }, catalog] = await Promise.all([
      storage.pages.layout(pageId),
      readComponentStatuses(storage),
      loadCatalog(locale),
    ]);
    const byId = new Map(components.map((each) => [each.id, each]));
    const level = worstStatus(
      componentsOf(layout).flatMap((id): StatusLevel[] => {
        const component = byId.get(id);
        return component ? [statuses.get(id) ?? component.status] : [];
      })
    );
    const { labels, statusColours } = page.customization;
    const label =
      statusNamesIn(labels, locale)[level] ??
      createMessages(locale, catalog)._(`component_level_${level}`);
    return {
      document: badgeSvg(
        contentIn(page.title, locale, page.locale),
        label,
        statusColours[level] ?? defaultStatusColours[level],
        locale
      ),
      ok: true,
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** The badge's public answer: SVG with `Cache-Control: public` and a sandbox policy, as a page's images have, 404 for no such page, 503 with no database. */
export function badgeResponse(
  result: ViewResult<string> | undefined
): Response {
  return publicResponse(result, "image/svg+xml; charset=utf-8", (svg) => svg, {
    "content-security-policy": imagePolicy,
    "x-content-type-options": "nosniff",
  });
}
