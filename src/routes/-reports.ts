/**
 * The report server functions: what the form offers to report on, and the
 * report one query asks for, each behind the operator session check. Not a
 * route file (the leading dash); the reports route shares them. A function
 * parses with the Zod schema and calls one module.
 */
import { createServerFn } from "@tanstack/react-start";
import { readReport, readReportChoices } from "@/server/reports/report.ts";
import {
  type ReportChoicesResult,
  type ReportResult,
  reportQuerySchema,
} from "@/shared/schemas/report.ts";
import { operatorMiddleware } from "./-admin.ts";

export const readReportChoicesFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<ReportChoicesResult> =>
      readReportChoices(context.storage)
  );

/** How long a report may take before it answers: a quarter of many monitors on a remote database reads for longer than Bun's ten idle seconds, as its download does, and a read waits its turn behind another. */
const readHoldSeconds = 60;

export const readReportFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(reportQuerySchema)
  .handler(({ context, data }): Promise<ReportResult> => {
    context.holdOpen(readHoldSeconds);
    return readReport(context.storage, data, Date.now());
  });
