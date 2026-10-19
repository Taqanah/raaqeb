/**
 * The metrics page (CONTEXT.md "Metrics endpoint", "Metrics token"). Off, one
 * button turns the endpoint on; that makes the token, shown once with the
 * Prometheus configuration that uses it. On, the page shows the address and
 * offers a new token, which stops the current one, and turning it off.
 */
import { type ReactNode, useCallback, useRef, useState } from "react";
import { FormFooter } from "@/admin/shell/page.tsx";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  MetricsTokenResult,
  MetricsView,
} from "@/shared/schemas/metrics.ts";
import type { SaveResult } from "@/shared/schemas/settings.ts";
import { Button } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { CopyButton } from "@/shared/ui/copy-button.tsx";
import { FieldError, FieldGroup, FieldLabel } from "@/shared/ui/field.tsx";
import { Token } from "@/shared/ui/token.tsx";

export interface MetricsFormProps {
  readonly makeToken: () => Promise<MetricsTokenResult>;
  readonly onChanged: () => void;
  readonly turnOff: () => Promise<SaveResult>;
  readonly view: MetricsView;
}

/** The scrape job that reads the install with the token; the host is the public address's, or a placeholder until one is saved. */
export function prometheusConfig(
  address: string | undefined,
  token: string
): string {
  const url = address === undefined ? undefined : new URL(address);
  const scheme = url ? url.protocol.slice(0, -1) : "https";
  return [
    "scrape_configs:",
    "  - job_name: raaqeb",
    `    scheme: ${scheme}`,
    "    authorization:",
    `      credentials: ${token}`,
    "    static_configs:",
    `      - targets: ["${url?.host ?? "status.example.com"}"]`,
  ].join("\n");
}

/** A machine text with its copy button; a block keeps its line breaks and scrolls sideways rather than wrap. */
function Copyable({
  block,
  copy,
  text,
}: {
  readonly block?: boolean;
  readonly copy: string;
  readonly text: string;
}): ReactNode {
  const shown = useRef<HTMLElement>(null);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <Token
        className={
          block
            ? "block min-w-0 select-all overflow-x-auto whitespace-pre px-3 py-2 leading-relaxed sm:flex-1"
            : "wrap-anywhere min-w-0 select-all py-1 sm:flex-1"
        }
        data-slot={copy}
        ref={shown}
      >
        {text}
      </Token>
      <CopyButton
        className="shrink-0 self-start"
        data-copy={copy}
        size="sm"
        target={shown}
        text={text}
      />
    </div>
  );
}

export function MetricsForm({
  makeToken,
  onChanged,
  turnOff,
  view,
}: MetricsFormProps): ReactNode {
  const { t } = useMessages();
  const [token, setToken] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // Each call answers a result; a rejected one (the server unreachable) reads as unavailable.
  const run = useCallback(
    <Result extends { ok: boolean }>(
      call: Promise<Result>,
      done: (result: Result) => void
    ) => {
      setPending(true);
      setUnavailable(false);
      call.then(
        (result) => {
          setPending(false);
          if (result.ok) {
            done(result);
          } else {
            setUnavailable(true);
          }
        },
        () => {
          setPending(false);
          setUnavailable(true);
        }
      );
    },
    []
  );
  const onMake = useCallback(
    () =>
      run(makeToken(), (result) => {
        if (result.ok) {
          setToken(result.token);
        }
      }),
    [makeToken, run]
  );
  const onOff = useCallback(
    () => run(turnOff(), onChanged),
    [onChanged, run, turnOff]
  );
  const onDone = useCallback(() => {
    setToken(undefined);
    onChanged();
  }, [onChanged]);
  const outcome = unavailable ? (
    <FieldError>{t("setting_unavailable")}</FieldError>
  ) : null;

  if (token !== undefined) {
    return (
      <Card data-slot="metrics-token">
        <CardHeader divided>
          <CardTitle>{t("setting_metrics_token_title")}</CardTitle>
          <CardDescription>{t("setting_metrics_token_intro")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Copyable copy="metrics-token-value" text={token} />
            <div className="flex flex-col gap-2">
              <FieldLabel>{t("setting_metrics_config")}</FieldLabel>
              <Copyable
                block
                copy="metrics-config"
                text={prometheusConfig(view.address, token)}
              />
            </div>
          </FieldGroup>
        </CardContent>
        <FormFooter>
          <Button data-slot="metrics-token-done" onClick={onDone} type="button">
            {t("setting_metrics_copied")}
          </Button>
        </FormFooter>
      </Card>
    );
  }

  return (
    <Card data-on={view.on} data-slot="metrics-form">
      <CardHeader divided>
        <CardTitle>{t("setting_metrics_title")}</CardTitle>
        <CardDescription>{t("setting_metrics_intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <p className="font-medium text-sm" data-slot="metrics-state">
            {view.on ? t("setting_metrics_on") : t("setting_metrics_off")}
          </p>
          {view.on ? (
            <>
              <div className="flex flex-col gap-2">
                <FieldLabel>{t("setting_metrics_address")}</FieldLabel>
                {view.address === undefined ? (
                  <p className="text-muted-foreground text-sm">
                    {t("setting_metrics_no_address")}
                  </p>
                ) : (
                  <Copyable copy="metrics-address" text={view.address} />
                )}
              </div>
              <p className="text-muted-foreground text-sm">
                {t("setting_metrics_new_token_note")}
              </p>
              <p className="text-muted-foreground text-sm">
                {t("setting_metrics_turn_off_note")}
              </p>
            </>
          ) : null}
        </FieldGroup>
      </CardContent>
      <FormFooter outcome={outcome}>
        {view.on ? (
          <>
            <Button
              data-slot="metrics-new-token"
              disabled={pending}
              onClick={onMake}
              type="button"
              variant="outline"
            >
              {t("setting_metrics_new_token")}
            </Button>
            <Button
              data-slot="metrics-off"
              disabled={pending}
              onClick={onOff}
              type="button"
              variant="destructive-outline"
            >
              {t("setting_metrics_turn_off")}
            </Button>
          </>
        ) : (
          <Button
            data-slot="metrics-on"
            disabled={pending}
            onClick={onMake}
            type="button"
          >
            {t("setting_metrics_turn_on")}
          </Button>
        )}
      </FormFooter>
    </Card>
  );
}
