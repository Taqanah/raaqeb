/**
 * The messages a status page's document inlines: the visitor's chrome under
 * the `public` area and the shared words it shows (the status levels, the
 * impact levels, the incident and maintenance
 * stages), and nothing of the admin, so a visitor's first paint carries a
 * small part of the catalog. `src/public` asks for no other id; a test
 * holds it to that.
 */
import { type Catalog, errorNoticeIds } from "./messages.ts";

/** The id prefixes the public page's document inlines. */
const publicPrefixes = [
  "public_",
  "component_level_",
  "incident_impact_",
  "incident_stage_",
  "maintenance_stage_",
  "setting_theme",
];

/** Single ids the public page shares with the admin: the subscribe dialog's close, the language switch's label and the error notice's words. */
const publicIds = new Set<string>([
  "app_close",
  "app_language",
  ...errorNoticeIds,
]);

/** Whether the public page's document inlines the message. */
export function isPublicMessage(id: string): boolean {
  return (
    publicIds.has(id) || publicPrefixes.some((prefix) => id.startsWith(prefix))
  );
}

/** The part of a compiled catalog the public page's document inlines. */
export function publicCatalog(catalog: Catalog): Catalog {
  return Object.fromEntries(
    Object.entries(catalog).filter(([id]) => isPublicMessage(id))
  );
}
