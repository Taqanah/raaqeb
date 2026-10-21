import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useCallback } from "react";
import { ReportForm } from "@/admin/reports/form.tsx";
import { ReportView } from "@/admin/reports/view.tsx";
import { formWidth, Page } from "@/admin/shell/page.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { readReportChoicesFn, readReportFn } from "@/routes/-reports.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  defaultUptimeTarget,
  type Report,
  type ReportResult,
  reportQuerySchema,
  reportSearchSchema,
} from "@/shared/schemas/report.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Button, buttonVariants } from "@/shared/ui/button.tsx";
import { cn } from "@/shared/ui/cn.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/shared/ui/empty.tsx";
import { FileIcon } from "@/shared/ui/icons.tsx";
import { Token } from "@/shared/ui/token.tsx";

// The reports page: what to report on, the period and the target are the
// address's search, so a report is a link that can be kept and shared. A
// search that names no report shows the form alone; one that does is read
// on the server, and its CSV is the same search on /admin/reports/report.csv.
export const Route = createFileRoute("/admin/reports/")({
  component: ReportsPage,
  validateSearch: (search) => reportSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ abortController: { signal }, deps }) => {
    const [choices, clock] = await Promise.all([
      readReportChoicesFn({ signal }),
      readOperatorClockFn({ signal }),
    ]);
    const query = reportQuerySchema.safeParse({
      ...deps,
      target: deps.target ?? defaultUptimeTarget,
    });
    const result = query.success
      ? await readReportFn({ data: query.data, signal })
      : undefined;
    return { choices, clock, now: Date.now(), result };
  },
  pendingComponent: () => <CardsSkeleton header />,
});

/** The CSV's address: the report's own query. */
function csvPath(report: Report): string {
  const query = new URLSearchParams({
    from: report.from,
    id: report.subject.id,
    subject: report.subject.kind,
    target: String(report.target),
    to: report.to,
  });
  return `/admin/reports/report.csv?${query}`;
}

function Actions({ report }: { readonly report: Report }): ReactNode {
  const { t } = useMessages();
  const print = useCallback(() => window.print(), []);
  return (
    <div className="flex items-center gap-2 print:hidden">
      <Button data-slot="print-report" onClick={print} variant="outline">
        {t("report_print")}
      </Button>
      <a
        className={cn(buttonVariants({ variant: "outline" }))}
        data-slot="download-report"
        download
        href={csvPath(report)}
      >
        <FileIcon />
        {t("report_download")}
      </a>
    </div>
  );
}

function Refusal({
  result,
}: {
  readonly result: Extract<ReportResult, { ok: false }>;
}): ReactNode {
  const { t } = useMessages();
  const words = {
    corrupt: "report_refused_corrupt",
    invalid: "report_refused_invalid",
    not_found: "report_refused_not_found",
    unavailable: "report_refused_unavailable",
  } as const;
  return (
    <Alert data-slot="report-refused" variant="destructive">
      <AlertDescription>
        {t(words[result.reason])}
        {result.id ? (
          <>
            {" "}
            <Token>{result.id}</Token>
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function ReportsPage(): ReactNode {
  const { choices, clock, now, result } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { t } = useMessages();
  const generate = useCallback(
    (asked: typeof search) => {
      navigate({ search: asked }).catch(() => undefined);
    },
    [navigate]
  );
  let body: ReactNode;
  if (!result) {
    body = (
      <Empty className={formWidth} data-slot="report-empty">
        <EmptyHeader>
          <EmptyTitle>{t("report_empty_title")}</EmptyTitle>
          <EmptyDescription>{t("report_empty_description")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (result.ok) {
    body = <ReportView clock={clock} report={result.report} />;
  } else {
    body = <Refusal result={result} />;
  }
  return (
    <Page
      action={result?.ok ? <Actions report={result.report} /> : undefined}
      title={t("report_list_title")}
    >
      {choices.ok ? (
        <div className={cn("print:hidden", formWidth)}>
          <ReportForm
            choices={choices.choices}
            clock={clock}
            key={JSON.stringify(search)}
            now={now}
            onSubmit={generate}
            search={search}
          />
        </div>
      ) : (
        <Alert variant="destructive">
          <AlertDescription>{t("report_refused_unavailable")}</AlertDescription>
        </Alert>
      )}
      {body}
    </Page>
  );
}
