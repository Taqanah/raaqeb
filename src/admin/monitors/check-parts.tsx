/**
 * What one check shows beyond its row: the failure detail
 * as label-value tokens under the reason, the raw error in monospace, and a
 * capture's headers and body. The form's "test now" panel and the detail
 * page's recent checks render the same parts.
 */
import type { ReactNode } from "react";
import { addressOf } from "@/shared/domain/monitors.ts";
import { formatUnit } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { CaptureHeader, CheckResult } from "@/shared/schemas/check.ts";
import type { CheckType } from "@/shared/schemas/monitor.ts";
import type { ReasonParams } from "@/shared/schemas/reason.ts";
import { Token } from "@/shared/ui/token.tsx";

export const resultWords: Readonly<Record<CheckResult, MessageId>> = {
  degraded: "monitor_degraded",
  down: "monitor_status_down",
  up: "monitor_status_up",
};

/** Each check type's name, as the list, the detail and the form show it. */
export const checkTypeLabels: Readonly<Record<CheckType, MessageId>> = {
  dns: "monitor_type_dns",
  docker: "monitor_type_docker",
  heartbeat: "monitor_type_heartbeat",
  http: "monitor_type_http",
  mysql: "monitor_type_mysql",
  postgres: "monitor_type_postgres",
  redis: "monitor_type_redis",
  tcp: "monitor_type_tcp",
};

/** A check's response time in the locale's millisecond unit; under 1 ms reads "< 1 ms", never 0. */
export function formatResponseTime(locale: Locale, ms: number): string {
  return ms < 1
    ? `< ${formatUnit(locale, 1, "millisecond")}`
    : formatUnit(locale, ms, "millisecond");
}

export function Pair({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}): ReactNode {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="wrap-anywhere min-w-0">{children}</dd>
    </>
  );
}

/** The target, expected and observed values a reason's parameters carry, then the raw error text; nothing when the check kept none. */
export function FailureDetail({
  failure,
}: {
  readonly failure:
    | { readonly error: string | undefined; readonly params: ReasonParams }
    | undefined;
}): ReactNode {
  const { locale, t } = useMessages();
  const detail = detailOf(locale, failure?.params);
  return (
    <>
      {detail.target === undefined &&
      detail.expected === undefined &&
      detail.observed === undefined ? null : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {detail.target === undefined ? null : (
            <Pair label={t("monitor_test_target")}>{detail.target}</Pair>
          )}
          {detail.expected === undefined ? null : (
            <Pair label={t("monitor_test_expected")}>{detail.expected}</Pair>
          )}
          {detail.observed === undefined ? null : (
            <Pair label={t("monitor_test_observed")}>{detail.observed}</Pair>
          )}
        </dl>
      )}
      {failure?.error ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            {t("monitor_test_error")}
          </span>
          {/* Words break at spaces first; only a word longer than the line breaks inside. */}
          <Token className="wrap-anywhere block whitespace-pre-wrap">
            {failure.error}
          </Token>
        </div>
      ) : null}
    </>
  );
}

/** The expected and observed values a reason's parameters carry: machine values as tokens, times inline in the locale's unit. */
function detailOf(
  locale: Locale,
  params: ReasonParams | undefined
): {
  readonly expected?: ReactNode;
  readonly observed?: ReactNode;
  readonly target?: ReactNode;
} {
  switch (params?.reason) {
    // What the check tried to reach, written as the monitor's target is.
    case "connection_refused":
      return { target: <Token>{addressOf(params.host, params.port)}</Token> };
    case "dns_failed":
      return { target: <Token>{params.host}</Token> };
    case "assertion_failed":
    case "dns_mismatch":
      return {
        expected: <Token>{params.expected}</Token>,
        observed: <Token>{params.observed}</Token>,
      };
    case "unexpected_status":
      return {
        expected: <Token>{params.expected.join(", ")}</Token>,
        observed: <Token>{String(params.observed)}</Token>,
      };
    // Docker's own words, as `docker ps` shows them: `exited (137)`.
    case "container_not_running":
      return {
        observed: (
          <Token>
            {params.state === "exited"
              ? `exited (${params.exitCode})`
              : params.state}
          </Token>
        ),
      };
    case "container_restarting":
      return { observed: <Token>{`restarting (${params.exitCode})`}</Token> };
    case "slow":
      return {
        expected: (
          <>
            {"< "}
            {formatUnit(locale, params.limitMs, "millisecond")}
          </>
        ),
        observed: formatUnit(locale, params.observedMs, "millisecond"),
      };
    default:
      return {};
  }
}

/** A capture's body as the view shows it: each control character but tab, newline and carriage return as U+FFFD, so a binary body stays readable. The stored bytes are untouched. */
export function printableBody(body: string): string {
  return body.replace(controlCharacters, "�");
}

/** C0 but tab, newline and carriage return; DEL; C1. */
const controlCharacters =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** A response as a capture keeps it: headers with credentials redacted, the first 4 KB of the body. */
export function CapturedResponse({
  response,
}: {
  readonly response: {
    readonly body: string;
    readonly headers: readonly CaptureHeader[];
  };
}): ReactNode {
  const { t } = useMessages();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          {t("monitor_test_headers")}
        </span>
        <ul className="flex flex-col gap-1 text-xs" dir="ltr">
          {response.headers.map((header, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a response repeats a header (two cookies), and the list never reorders
            <li className="break-all font-mono" key={index}>
              {header.name}:{" "}
              {header.value ?? (
                <span className="text-muted-foreground" dir="auto">
                  {t("monitor_test_redacted")}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {response.body === "" ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            {t("monitor_test_body")}
          </span>
          <pre
            className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-foreground p-3 font-mono text-background text-xs"
            dir="ltr"
          >
            {printableBody(response.body)}
          </pre>
        </div>
      )}
    </div>
  );
}
