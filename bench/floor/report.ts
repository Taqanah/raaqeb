/**
 * The report: the viewer in `report/` built by Bun into one
 * self-contained HTML file, with the run's results, its history row, the
 * previous release's row and the noise band written into it as JSON, so it
 * opens from disk with no server.
 */
import type { NoiseBand } from "./band.ts";
import type { HistoryRow, RowValues, RunResult } from "./results.ts";

/** What the viewer draws. */
export interface ReportData {
  readonly band: NoiseBand | undefined;
  readonly previous: HistoryRow | undefined;
  readonly result: RunResult;
  readonly row: RowValues;
}

/** The id of the script element the viewer reads its data from. */
export const reportDataId = "raaqeb-bench-data";

/** The built viewer with the data written into it, ahead of its scripts; a `<` in the data can never close the element. */
export function reportHtml(viewer: string, data: ReportData): string {
  // `<\/` reads as `</` in JSON and can never close the element.
  const json = JSON.stringify(data).replaceAll("</", "<\\/");
  const element = `<script type="application/json" id="${reportDataId}">${json}</script>`;
  const head = viewer.indexOf("</head>");
  return head === -1
    ? `${element}${viewer}`
    : `${viewer.slice(0, head)}${element}${viewer.slice(head)}`;
}

/** The newest row of the history file; nothing when it has none. */
export function lastRow(history: string): HistoryRow | undefined {
  const lines = history.split("\n").filter((line) => line.trim() !== "");
  const last = lines.at(-1);
  return last === undefined ? undefined : (JSON.parse(last) as HistoryRow);
}
