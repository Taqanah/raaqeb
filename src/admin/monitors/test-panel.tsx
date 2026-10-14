/**
 * The form's "test now" panel: one check of the
 * form as it stands, nothing recorded. It shows what the scheduler would
 * store (the result, the reason, the response time, the status code), the
 * failure detail, each assertion's state, and for HTTP the response as a
 * capture keeps it: headers with credentials redacted and the first 4 KB of
 * the body. A TCP test shows the address it connected to and a DNS test the
 * records its resolver answered, and a database test the value its query
 * answered, which no check row keeps. Machine
 * tokens are isolated LTR.
 */
import type { ReactNode } from "react";
import { formatBytes, formatUnit } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  Assertion,
  MonitorRefusal,
  MonitorTest,
} from "@/shared/schemas/monitor.ts";
import { reasonMessageId } from "@/shared/schemas/reason.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Badge } from "@/shared/ui/badge.tsx";
import { Button } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { Token } from "@/shared/ui/token.tsx";
import {
  CapturedResponse,
  FailureDetail,
  formatResponseTime,
  Pair,
  resultWords,
} from "./check-parts.tsx";
import { type AssertionState, assertionStates } from "./draft.ts";
import { assertionKindLabel } from "./http-sections.tsx";

export type TestState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  /** Refused before the check ran; "invalid" is the form itself, its fields marked. */
  | { readonly kind: "refused"; readonly reason: MonitorRefusal }
  | {
      readonly kind: "done";
      /** The assertions the test ran with, so a later edit of the form does not relabel the result. */
      readonly assertions: readonly Assertion[];
      readonly test: MonitorTest;
    };

const stateWords: Readonly<Record<AssertionState, MessageId>> = {
  failed: "monitor_assertion_failed",
  passed: "monitor_assertion_passed",
  unreached: "monitor_assertion_unreached",
};

const stateBadges = {
  failed: "down",
  passed: "up",
  unreached: "secondary",
} as const;

export function TestPanel({
  onRun,
  state,
}: {
  readonly onRun: () => void;
  readonly state: TestState;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Card className="lg:sticky lg:top-20" data-slot="test-panel">
      <CardHeader divided>
        <CardTitle>{t("monitor_test_title")}</CardTitle>
        <CardDescription>{t("monitor_test_hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Button
          className="self-start"
          data-slot="test-now"
          disabled={state.kind === "running"}
          onClick={onRun}
          type="button"
          // Outline, as the channel's send test: Save is the page's one primary button.
          variant="outline"
        >
          {state.kind === "running"
            ? t("monitor_test_running")
            : t("monitor_test_run")}
        </Button>
        <TestOutcome state={state} />
      </CardContent>
    </Card>
  );
}

function TestOutcome({ state }: { readonly state: TestState }): ReactNode {
  const { t } = useMessages();
  switch (state.kind) {
    case "refused":
      return (
        <Alert variant="destructive">
          <AlertDescription>
            {state.reason === "invalid"
              ? t("app_form_invalid")
              : t("monitor_test_unavailable")}
          </AlertDescription>
        </Alert>
      );
    case "done":
      return <TestResult assertions={state.assertions} test={state.test} />;
    default:
      return null;
  }
}

function TestResult({
  assertions,
  test,
}: {
  readonly assertions: readonly Assertion[];
  readonly test: MonitorTest;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <div
      className="flex flex-col gap-4"
      data-result={test.result}
      data-slot="test-result"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={test.result}>{t(resultWords[test.result])}</Badge>
        <span className="text-sm">{t(reasonMessageId(test.reason))}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {test.responseMs === undefined ? null : (
          <Pair label={t("monitor_test_response_time")}>
            {formatResponseTime(locale, test.responseMs)}
          </Pair>
        )}
        {test.statusCode === undefined ? null : (
          <Pair label={t("monitor_test_status_code")}>
            <Token>{String(test.statusCode)}</Token>
          </Pair>
        )}
        {test.response ? (
          <Pair label={t("monitor_test_bytes")}>
            {formatBytes(locale, test.bytes)}
          </Pair>
        ) : null}
        {test.address === undefined ? null : (
          <Pair label={t("monitor_test_address")}>
            <span data-slot="test-address">
              <Token>{test.address}</Token>
            </span>
          </Pair>
        )}
        {test.answer === undefined ? null : (
          <Pair label={t("monitor_test_answer")}>
            <span data-slot="test-answer">
              <Token>{test.answer}</Token>
            </span>
          </Pair>
        )}
        {test.records?.length ? (
          <Pair label={t("monitor_test_records")}>
            <ul
              className="flex flex-col items-start gap-1"
              data-slot="test-records"
            >
              {test.records.map((record, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the records are the test's own snapshot, and two may be the same text
                <li key={index}>
                  <Token>{record}</Token>
                </li>
              ))}
            </ul>
          </Pair>
        ) : null}
      </dl>
      <FailureDetail failure={test.failure} />
      {assertions.length > 0 ? (
        <AssertionList assertions={assertions} test={test} />
      ) : null}
      {test.response ? <CapturedResponse response={test.response} /> : null}
    </div>
  );
}

function AssertionList({
  assertions,
  test,
}: {
  readonly assertions: readonly Assertion[];
  readonly test: MonitorTest;
}): ReactNode {
  const { locale, t } = useMessages();
  const states = assertionStates(assertions, test);
  return (
    <ul className="flex flex-col divide-y">
      {assertions.map((assertion, index) => {
        const state = states[index] ?? "unreached";
        return (
          <li
            className="flex items-center justify-between gap-3 py-2 text-sm"
            // biome-ignore lint/suspicious/noArrayIndexKey: the assertions are the test's own snapshot and never reorder
            key={index}
          >
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              {t(assertionKindLabel(assertion.kind))}
              {assertionValue(locale, assertion)}
            </span>
            <Badge
              data-slot="assertion-state"
              data-state={state}
              variant={stateBadges[state]}
            >
              {t(stateWords[state])}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

/** What an assertion checks: a machine token, or the response time limit inline in the locale's unit. */
function assertionValue(locale: Locale, assertion: Assertion): ReactNode {
  if (assertion.kind === "response_time_under") {
    // Its own element, so the row's gap separates it from the label; bare text would join it.
    return <span>{formatUnit(locale, assertion.ms, "millisecond")}</span>;
  }
  return <Token className="truncate">{assertionText(assertion)}</Token>;
}

function assertionText(
  assertion: Exclude<Assertion, { readonly kind: "response_time_under" }>
): string {
  switch (assertion.kind) {
    case "status":
      return assertion.codes.join(", ");
    case "body_contains":
    case "body_not_contains":
      return assertion.text;
    case "json_equals":
      return `${assertion.path} = ${assertion.value}`;
    case "json_matches":
      return `${assertion.path} ~ ${assertion.pattern}`;
    default:
      return `${assertion.name}: ${assertion.value}`;
  }
}
