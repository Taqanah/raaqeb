/**
 * The authenticator app's card on the sign-in settings page. Off, the
 * current password starts the setup: the QR code and the key as text, then
 * the app's first code, which turns the second step on and shows the ten
 * backup codes once. On, the password makes a new set of backup codes or
 * turns the app off alone; the second step stays on with emailed codes when
 * a test message went through, and goes off with the app otherwise.
 */
import { type ReactNode, type SubmitEvent, useCallback, useState } from "react";
import { encode } from "uqr";
import { FormFooter } from "@/admin/shell/page.tsx";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  AppConfirmInput,
  AppConfirmRefusal,
  AppConfirmResult,
  AppPasswordInput,
  AppPasswordRefusal,
  AppSetupResult,
  BackupCodesResult,
  SecondStepRefusal,
  SecondStepResult,
  SecondStepView,
} from "@/shared/schemas/settings.ts";
import { Button, buttonVariants } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { Token } from "@/shared/ui/token.tsx";

export interface AuthenticatorFormProps {
  readonly confirm: (input: AppConfirmInput) => Promise<AppConfirmResult>;
  readonly newCodes: (input: AppPasswordInput) => Promise<BackupCodesResult>;
  readonly onChanged: () => void;
  readonly setUp: (input: AppPasswordInput) => Promise<AppSetupResult>;
  readonly turnOff: (input: AppPasswordInput) => Promise<SecondStepResult>;
  readonly view: SecondStepView;
}

type Refusal = AppPasswordRefusal | AppConfirmRefusal | SecondStepRefusal;

const refusalMessages: Readonly<Record<Refusal, MessageId>> = {
  invalid: "setting_invalid",
  not_tested: "setting_second_step_not_tested",
  unavailable: "setting_unavailable",
  wrong_code: "setting_authenticator_code_wrong",
  wrong_password: "setting_password_wrong",
};

type Stage =
  | { readonly kind: "password" }
  | {
      readonly kind: "scan";
      readonly backupCodes: readonly string[];
      readonly secret: string;
      readonly uri: string;
    }
  | { readonly kind: "codes"; readonly backupCodes: readonly string[] };

/** The card's three stages: the password, the QR code with the first code, and the backup codes shown once. */
export function AuthenticatorForm({
  confirm,
  newCodes,
  onChanged,
  setUp,
  turnOff,
  view,
}: AuthenticatorFormProps): ReactNode {
  const { t } = useMessages();
  const [stage, setStage] = useState<Stage>({ kind: "password" });
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | undefined>();
  // Each call answers a result; a rejected one (the server unreachable) reads as unavailable.
  const run = useCallback(
    <Result extends { ok: boolean }>(
      call: Promise<Result>,
      done: (result: Result) => void
    ) => {
      setPending(true);
      setRefusal(undefined);
      call.then(
        (result) => {
          setPending(false);
          done(result);
        },
        () => {
          setPending(false);
          setRefusal("unavailable");
        }
      );
    },
    []
  );
  const onPassword = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form, event.nativeEvent.submitter);
      const password = String(data.get("password") ?? "");
      const intent = data.get("intent");
      if (password === "") {
        setRefusal("invalid");
        return;
      }
      form.reset();
      if (intent === "off") {
        run(turnOff({ password }), (result) => {
          if (result.ok) {
            onChanged();
          } else {
            setRefusal(result.reason);
          }
        });
        return;
      }
      if (intent === "codes") {
        run(newCodes({ password }), (result) => {
          if (result.ok) {
            setStage({ backupCodes: result.backupCodes, kind: "codes" });
          } else {
            setRefusal(result.reason);
          }
        });
        return;
      }
      run(setUp({ password }), (result) => {
        if (result.ok) {
          setStage({ ...result, kind: "scan" });
        } else {
          setRefusal(result.reason);
        }
      });
    },
    [newCodes, onChanged, run, setUp, turnOff]
  );
  const onCode = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (stage.kind !== "scan") {
        return;
      }
      const code = String(new FormData(event.currentTarget).get("code") ?? "");
      run(confirm({ code }), (result) => {
        if (result.ok) {
          setStage({ backupCodes: stage.backupCodes, kind: "codes" });
          onChanged();
        } else {
          setRefusal(result.reason);
        }
      });
    },
    [confirm, onChanged, run, stage]
  );
  const back = useCallback(() => {
    setRefusal(undefined);
    setStage({ kind: "password" });
  }, []);
  const outcome = refusal ? (
    <FieldError>{t(refusalMessages[refusal])}</FieldError>
  ) : null;
  const header = (
    <CardHeader divided>
      <CardTitle>{t("setting_authenticator_title")}</CardTitle>
      <CardDescription>{t("setting_authenticator_intro")}</CardDescription>
    </CardHeader>
  );

  if (stage.kind === "codes") {
    return (
      <Card data-slot="backup-codes">
        <CardHeader divided>
          <CardTitle>{t("setting_backup_title")}</CardTitle>
          <CardDescription>{t("setting_backup_intro")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ol
            className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-sm"
            dir="ltr"
          >
            {stage.backupCodes.map((code) => (
              <li data-slot="backup-code" key={code}>
                {code}
              </li>
            ))}
          </ol>
        </CardContent>
        <FormFooter>
          <a
            className={buttonVariants({ variant: "outline" })}
            download="raaqeb-backup-codes.txt"
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${stage.backupCodes.join("\n")}\n`)}`}
          >
            {t("setting_backup_download")}
          </a>
          <Button data-slot="backup-codes-done" onClick={back} type="button">
            {t("setting_backup_done")}
          </Button>
        </FormFooter>
      </Card>
    );
  }

  if (stage.kind === "scan") {
    return (
      <form data-slot="authenticator-scan" method="post" onSubmit={onCode}>
        <Card>
          {header}
          <CardContent>
            <FieldGroup>
              <p className="text-sm">{t("setting_authenticator_scan")}</p>
              <QrCode label={t("setting_authenticator_qr")} text={stage.uri} />
              <Field>
                <FieldLabel>{t("setting_authenticator_key")}</FieldLabel>
                {/* One click selects the whole key; the groups of four are for reading, and apps ignore the spaces. */}
                <Token
                  className="block select-all break-all px-3 py-2 leading-relaxed"
                  data-slot="authenticator-key"
                >
                  {stage.secret.replace(/(.{4})(?=.)/g, "$1 ")}
                </Token>
              </Field>
              <Field>
                <FieldLabel htmlFor="appCode">
                  {t("setting_authenticator_code")}
                </FieldLabel>
                <Input
                  autoComplete="one-time-code"
                  className="max-w-40 tracking-widest"
                  id="appCode"
                  inputMode="numeric"
                  maxLength={6}
                  name="code"
                  required
                  variant="token"
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <FormFooter outcome={outcome}>
            <Button onClick={back} type="button" variant="ghost">
              {t("app_cancel")}
            </Button>
            <Button disabled={pending} type="submit">
              {pending ? t("app_saving") : t("setting_authenticator_confirm")}
            </Button>
          </FormFooter>
        </Card>
      </form>
    );
  }

  return (
    <form
      data-app={view.app}
      data-slot="authenticator-form"
      method="post"
      onSubmit={onPassword}
    >
      <Card>
        {header}
        <CardContent>
          <FieldGroup>
            <p className="font-medium text-sm" data-slot="authenticator-state">
              {view.app
                ? t("setting_authenticator_on")
                : t("setting_authenticator_off")}
            </p>
            {view.app ? (
              <p className="text-muted-foreground text-sm">
                {t("setting_backup_new_note")}{" "}
                {/* What the app's off leaves, by the same guard that turns emailed codes on. */}
                {view.tested
                  ? t("setting_authenticator_off_keeps_email")
                  : t("setting_authenticator_off_ends_step")}
              </p>
            ) : null}
            <Field>
              <FieldLabel htmlFor="authenticatorPassword">
                {t("setting_password_current")}
              </FieldLabel>
              <Input
                autoComplete="current-password"
                id="authenticatorPassword"
                name="password"
                required
                type="password"
              />
            </Field>
          </FieldGroup>
        </CardContent>
        <FormFooter outcome={outcome}>
          {/* The first submit button is the one Enter presses: never the one that turns the app off. */}
          {view.app ? (
            <>
              <Button
                disabled={pending}
                name="intent"
                type="submit"
                value="codes"
                variant="outline"
              >
                {t("setting_backup_new")}
              </Button>
              <Button
                disabled={pending}
                name="intent"
                type="submit"
                value="off"
                variant="destructive-outline"
              >
                {t("setting_authenticator_disable")}
              </Button>
            </>
          ) : (
            <Button
              disabled={pending}
              name="intent"
              type="submit"
              value="set-up"
            >
              {pending ? t("app_saving") : t("setting_authenticator_set_up")}
            </Button>
          )}
        </FormFooter>
      </Card>
    </form>
  );
}

/** The QR code an authenticator app scans: dark modules on white whatever the theme, with the four-module quiet zone scanners need. */
function QrCode({
  label,
  text,
}: {
  readonly label: string;
  readonly text: string;
}): ReactNode {
  const { data } = encode(text, { border: 4, ecc: "M" });
  let path = "";
  for (const [y, row] of data.entries()) {
    for (const [x, dark] of row.entries()) {
      if (dark) {
        path += `M${x} ${y}h1v1h-1z`;
      }
    }
  }
  return (
    <svg
      aria-label={label}
      className="size-52 rounded-md bg-white"
      data-slot="authenticator-qr"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${data.length} ${data.length}`}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
