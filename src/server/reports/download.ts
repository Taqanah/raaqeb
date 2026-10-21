/**
 * A report's CSV download (CONTEXT.md "Report"): the report the query asks
 * for, written in the operator's language with each component's and page's
 * name as the operator reads it.
 */
import { reportCsv, reportFileName } from "@/server/reports/csv.ts";
import { type ReportStorage, readReport } from "@/server/reports/report.ts";
import {
  loadCatalog,
  readInstallLanguage,
} from "@/server/settings/language.ts";
import { readOperatorLanguage } from "@/server/settings/operator.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { contentIn } from "@/shared/schemas/content.ts";
import type { ReportQuery } from "@/shared/schemas/report.ts";

export type ReportDownloadResult =
  | { readonly body: string; readonly name: string; readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "corrupt" | "invalid" | "not_found" | "unavailable";
    };

export async function reportDownload(
  storage: ReportStorage,
  query: ReportQuery,
  now: number
): Promise<ReportDownloadResult> {
  const result = await readReport(storage, query, now);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  try {
    const [locale, install] = await Promise.all([
      readOperatorLanguage(storage),
      readInstallLanguage(storage),
    ]);
    const messages = createMessages(locale, await loadCatalog(locale));
    const body = reportCsv(result.report, {
      name: (name) =>
        typeof name === "string" ? name : contentIn(name, locale, install),
      text: (id) => messages._(id),
    });
    return { body, name: reportFileName(result.report), ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
