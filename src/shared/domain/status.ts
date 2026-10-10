/**
 * Worst wins (CONTEXT.md "Status level", "Component group"): a
 * component group's aggregate and a page's status level are the worst
 * status level among the components they hold, in the order operational,
 * under maintenance, degraded performance, partial outage, major outage.
 * Shared, because the page editor recomputes both as the operator moves
 * components; the rules that need monitors and incidents are server/status.
 */
import type { Locale } from "@/shared/i18n/locale.ts";
import type { Content } from "@/shared/schemas/content.ts";
import { type StatusLevel, statusLevels } from "@/shared/schemas/status.ts";

/** The worst of the levels; operational for none. */
export function worstStatus(levels: Iterable<StatusLevel>): StatusLevel {
  let worst: StatusLevel = "operational";
  for (const level of levels) {
    if (statusLevels.indexOf(level) > statusLevels.indexOf(worst)) {
      worst = level;
    }
  }
  return worst;
}

/** A page's own status names in one locale, by level. */
export type StatusNames = Readonly<Partial<Record<StatusLevel, string>>>;

/**
 * The status names a view in `locale` shows: the ones the operator wrote in
 * that locale. A level without one keeps the catalog's word rather than the
 * page language's name, since the catalog already speaks the view's locale
 *.
 */
export function statusNamesIn(
  labels: Readonly<Partial<Record<StatusLevel, Content>>>,
  locale: Locale
): StatusNames {
  const names: Partial<Record<StatusLevel, string>> = {};
  for (const level of statusLevels) {
    const name = labels[level]?.[locale];
    if (name) {
      names[level] = name;
    }
  }
  return names;
}
