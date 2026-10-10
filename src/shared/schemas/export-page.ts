/**
 * The export and import page's addresses and search. Apart from the file's
 * schema (export.ts), since the Start instance and the page's search
 * validation are in the client entry every page loads, the public one
 * included, and the file's schema pulls in every channel's declaration
 * (e2e/views.spec.ts).
 */
import { z } from "zod";

/** Where the settings page downloads an export and uploads one to import. */
export const exportPath = "/admin/export";
export const importPath = "/admin/import";

/** Why an export could not start: another export is downloading, the database did not answer, or the install key cannot open a record's credentials. */
export const exportRefusals = ["busy", "unavailable", "unreadable"] as const;
export type ExportRefusal = (typeof exportRefusals)[number];

/** The size of the file each export mode downloads, the full one estimated, or why the export cannot start. */
export type ExportSizes =
  | { readonly configuration: number; readonly full: number; readonly ok: true }
  | { readonly ok: false; readonly reason: ExportRefusal };

/** The settings page's search after a refused download: the refusal and, for credentials the key cannot open, the record's id. */
export const exportPageSearchSchema = z.object({
  refused: z.enum(exportRefusals).optional().catch(undefined),
  record: z.string().min(1).optional().catch(undefined),
});
