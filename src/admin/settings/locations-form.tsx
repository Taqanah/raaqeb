/**
 * The locations page (CONTEXT.md "Location", "Probe", "Probe token"): the
 * main location and every probe with when the install last heard from it,
 * its build and its round trip; a probe is made with a name, given a new
 * token or deleted. A token is shown once, with the lines that run the probe.
 */
import { type ReactNode, useCallback, useId, useRef, useState } from "react";
import { formatResponseTime } from "@/admin/monitors/check-parts.tsx";
import { FormFooter } from "@/admin/shell/page.tsx";
import {
  formatDateTimeWithZone,
  formatWhen,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { probesMax } from "@/shared/schemas/monitor.ts";
import {
  type Probe,
  type ProbeRemoveResult,
  type ProbesView,
  type ProbeTokenResult,
  probeNameMaxLength,
  probeSilentAfterMs,
} from "@/shared/schemas/probe.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog.tsx";
import { Badge } from "@/shared/ui/badge.tsx";
import { Button } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { CopyButton } from "@/shared/ui/copy-button.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { Token } from "@/shared/ui/token.tsx";

export interface LocationsFormProps {
  readonly clock: TimeOptions;
  readonly make: (name: string) => Promise<ProbeTokenResult>;
  readonly onChanged: () => void;
  readonly remove: (id: string) => Promise<ProbeRemoveResult>;
  readonly renew: (id: string) => Promise<ProbeTokenResult>;
  readonly view: ProbesView;
}

/** Where a probe's lines point while no public address is stored. */
const placeholderAddress = "https://status.example.com";

/** The lines that run a probe: as a command, and as a container whose health check, `serve`'s, it turns off. */
export function probeLines(
  address: string | undefined,
  token: string
): { readonly command: string; readonly docker: string } {
  const server = address ?? placeholderAddress;
  return {
    command: `RAAQEB_PROBE_SERVER=${server} RAAQEB_PROBE_TOKEN=${token} raaqeb probe`,
    docker: `docker run -d --name raaqeb-probe --restart unless-stopped --no-healthcheck -e RAAQEB_PROBE_SERVER=${server} -e RAAQEB_PROBE_TOKEN=${token} ghcr.io/taqanah/raaqeb probe`,
  };
}

/** A machine text with its copy button. */
function Copyable({
  copy,
  text,
}: {
  readonly copy: string;
  readonly text: string;
}): ReactNode {
  const shown = useRef<HTMLElement>(null);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <Token
        className="wrap-anywhere min-w-0 select-all py-1 sm:flex-1"
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

export function LocationsForm({
  clock,
  make,
  onChanged,
  remove,
  renew,
  view,
}: LocationsFormProps): ReactNode {
  const { t } = useMessages();
  const [shown, setShown] = useState<
    { readonly name: string; readonly token: string } | undefined
  >();
  const onToken = useCallback((result: ProbeTokenResult) => {
    if (result.ok) {
      setShown({ name: result.probe.name, token: result.token });
    }
  }, []);
  const onDone = useCallback(() => {
    setShown(undefined);
    onChanged();
  }, [onChanged]);

  if (shown) {
    const lines = probeLines(view.address, shown.token);
    return (
      <Card data-slot="probe-token">
        <CardHeader divided>
          <CardTitle>
            {t("setting_probe_token_title", { name: shown.name })}
          </CardTitle>
          <CardDescription>{t("setting_probe_token_intro")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Copyable copy="probe-token-value" text={shown.token} />
            {view.address === undefined ? (
              <p className="text-muted-foreground text-sm">
                {t("setting_probe_no_address")}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              <FieldLabel>{t("setting_probe_command")}</FieldLabel>
              <Copyable copy="probe-command" text={lines.command} />
            </div>
            <div className="flex flex-col gap-2">
              <FieldLabel>{t("setting_probe_docker")}</FieldLabel>
              <Copyable copy="probe-docker" text={lines.docker} />
            </div>
          </FieldGroup>
        </CardContent>
        <FormFooter>
          <Button data-slot="probe-token-done" onClick={onDone} type="button">
            {t("setting_probe_copied")}
          </Button>
        </FormFooter>
      </Card>
    );
  }

  return (
    <>
      <Card data-slot="locations">
        <CardHeader divided>
          <CardTitle>{t("setting_locations_title")}</CardTitle>
          <CardDescription>{t("setting_locations_intro")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            <li
              className="flex flex-col gap-1 py-3 first:pt-0"
              data-probe="main"
            >
              <span className="font-medium text-sm">
                {t("monitor_location_main")}
              </span>
              <span className="text-muted-foreground text-sm">
                {t("setting_locations_main_note")}
              </span>
            </li>
            {view.probes.map((probe) => (
              <ProbeRow
                clock={clock}
                key={probe.id}
                now={view.now}
                onChanged={onChanged}
                onToken={onToken}
                probe={probe}
                refused={view.refused.includes(probe.id)}
                remove={remove}
                renew={renew}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
      <AddProbe
        full={view.probes.length >= probesMax}
        make={make}
        onToken={onToken}
      />
    </>
  );
}

function ProbeRow({
  clock,
  now,
  onChanged,
  onToken,
  probe,
  refused,
  remove,
  renew,
}: {
  readonly clock: TimeOptions;
  readonly now: number;
  readonly onChanged: () => void;
  readonly onToken: (result: ProbeTokenResult) => void;
  readonly probe: Probe;
  /** The install refused its latest push whole. */
  readonly refused: boolean;
  readonly remove: (id: string) => Promise<ProbeRemoveResult>;
  readonly renew: (id: string) => Promise<ProbeTokenResult>;
}): ReactNode {
  const { locale, t } = useMessages();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const settle = useCallback(
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
  const onRenew = useCallback(
    () => settle(renew(probe.id), onToken),
    [onToken, probe.id, renew, settle]
  );
  const ask = useCallback(() => setOpen(true), []);
  const onRemove = useCallback(
    () => settle(remove(probe.id), onChanged),
    [onChanged, probe.id, remove, settle]
  );
  const { lastSeenAt } = probe;
  let state: ReactNode = (
    <Badge variant="secondary">{t("setting_probe_never")}</Badge>
  );
  if (refused) {
    state = (
      <Badge title={t("setting_probe_refused_note")} variant="down">
        {t("setting_probe_refused")}
      </Badge>
    );
  } else if (lastSeenAt !== undefined) {
    state =
      now - lastSeenAt < probeSilentAfterMs ? (
        <Badge variant="up">{t("setting_probe_reporting")}</Badge>
      ) : (
        <Badge variant="degraded">{t("setting_probe_silent")}</Badge>
      );
  }
  return (
    <li
      className="flex flex-col gap-3 py-3 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
      data-probe={probe.id}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-3">
          <bdi className="truncate font-medium text-sm">{probe.name}</bdi>
          {state}
        </span>
        <span className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-sm tabular-nums">
          {lastSeenAt === undefined ? null : (
            <time
              dateTime={new Date(lastSeenAt).toISOString()}
              title={formatDateTimeWithZone(locale, lastSeenAt, clock)}
            >
              {t("setting_probe_last_seen", {
                when: formatWhen(locale, lastSeenAt, { ...clock, now }),
              })}
            </time>
          )}
          {probe.version === undefined ? null : (
            <span>{t("setting_probe_version", { value: probe.version })}</span>
          )}
          {probe.roundTripMs === undefined ? null : (
            <span>
              {t("setting_probe_round_trip", {
                value: formatResponseTime(locale, probe.roundTripMs),
              })}
            </span>
          )}
        </span>
        {unavailable ? (
          <FieldError>{t("setting_unavailable")}</FieldError>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          data-slot="probe-new-token"
          disabled={pending}
          onClick={onRenew}
          size="sm"
          title={t("setting_probe_new_token_note")}
          type="button"
          variant="outline"
        >
          {t("setting_probe_new_token")}
        </Button>
        <Button
          data-slot="probe-delete"
          disabled={pending}
          onClick={ask}
          size="sm"
          type="button"
          variant="destructive-outline"
        >
          {t("setting_probe_delete")}
        </Button>
      </div>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("setting_probe_delete_title", { name: probe.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("setting_probe_delete_body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("app_cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-slot="confirm-delete-probe"
              onClick={onRemove}
              variant="destructive"
            >
              {t("setting_probe_delete_confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function AddProbe({
  full,
  make,
  onToken,
}: {
  readonly full: boolean;
  readonly make: (name: string) => Promise<ProbeTokenResult>;
  readonly onToken: (result: ProbeTokenResult) => void;
}): ReactNode {
  const { t } = useMessages();
  const field = useId();
  const [name, setName] = useState("");
  const [refusal, setRefusal] = useState<
    "name" | "full" | "unavailable" | undefined
  >();
  const [pending, setPending] = useState(false);
  const onName = useCallback((event: { currentTarget: HTMLInputElement }) => {
    setName(event.currentTarget.value);
    setRefusal(undefined);
  }, []);
  const onSubmit = useCallback(
    (event: { preventDefault: () => void }) => {
      event.preventDefault();
      if (name.trim() === "") {
        setRefusal("name");
        return;
      }
      setPending(true);
      make(name).then(
        (result) => {
          setPending(false);
          if (result.ok) {
            setName("");
            onToken(result);
          } else {
            setRefusal(result.reason === "full" ? "full" : "unavailable");
          }
        },
        () => {
          setPending(false);
          setRefusal("unavailable");
        }
      );
    },
    [make, name, onToken]
  );
  let outcome: ReactNode = null;
  if (refusal === "unavailable") {
    outcome = <FieldError>{t("setting_unavailable")}</FieldError>;
  } else if (refusal === "full") {
    outcome = (
      <FieldError>{t("setting_probe_full", { count: probesMax })}</FieldError>
    );
  }
  return (
    <Card data-slot="add-probe">
      <form className="contents" noValidate onSubmit={onSubmit}>
        <CardHeader divided>
          <CardTitle>{t("setting_probe_add_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Field data-invalid={refusal === "name" ? true : undefined}>
            <FieldLabel htmlFor={field}>{t("setting_probe_name")}</FieldLabel>
            <Input
              aria-invalid={refusal === "name" ? true : undefined}
              disabled={full}
              id={field}
              maxLength={probeNameMaxLength}
              name="name"
              onChange={onName}
              value={name}
            />
            {refusal === "name" ? (
              <FieldError>{t("setting_probe_name_needed")}</FieldError>
            ) : (
              <FieldDescription>
                {full
                  ? t("setting_probe_full", { count: probesMax })
                  : t("setting_probe_name_hint")}
              </FieldDescription>
            )}
          </Field>
        </CardContent>
        <FormFooter outcome={outcome}>
          <Button
            data-slot="probe-add"
            disabled={pending || full}
            type="submit"
          >
            {t("setting_probe_add")}
          </Button>
        </FormFooter>
      </form>
    </Card>
  );
}
