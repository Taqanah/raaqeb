/**
 * The second step's form: the authenticator app's code when
 * one is set up, else the six-digit one-time code emailed at sign-in, with
 * "trust this browser for 30 days". From the app's code the operator can
 * switch to a backup code and, where an email channel exists, have a code
 * emailed. A sign-in whose ten minutes or attempts ran out starts over from
 * the password.
 */
import { type ReactNode, type SubmitEvent, useCallback, useState } from "react";
import { sendCode, verifyCode } from "@/shared/api/auth.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { CodeFailure, CodeMethod } from "@/shared/schemas/auth.ts";
import { Button } from "@/shared/ui/button.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { AuthPage } from "./auth-page.tsx";

export interface CodeFormProps {
  /** An authenticator app is set up: its code is asked first. */
  readonly app: boolean;
  /** An email channel exists, so a code can be emailed instead of the app's. */
  readonly email: boolean;
  /** Back to the password, when the pending sign-in is gone. */
  readonly onRestart: () => void;
  readonly onSignedIn: () => void;
  /** Whether the first emailed code went out at sign-in. */
  readonly sent: boolean;
}

const failureMessage = {
  expired: "auth_code_expired",
  locked: "auth_code_locked",
  no_attempts_left: "auth_code_no_attempts",
  rate_limited: "auth_rate_limited",
  start_over: "auth_code_start_over",
  unavailable: "auth_unavailable",
  wrong_code: "auth_code_wrong",
} as const satisfies Record<CodeFailure, MessageId>;

const methodText = {
  app: { intro: "auth_code_app_intro", label: "auth_code_app_label" },
  backup: { intro: "auth_code_backup_intro", label: "auth_code_backup_label" },
  email: { intro: "auth_code_intro", label: "auth_code_label" },
} as const satisfies Record<
  CodeMethod,
  { readonly intro: MessageId; readonly label: MessageId }
>;

type Notice = "resent" | "not_sent" | undefined;

export function CodeForm({
  app,
  email,
  onRestart,
  onSignedIn,
  sent,
}: CodeFormProps): ReactNode {
  const { t } = useMessages();
  const [method, setMethod] = useState<CodeMethod>(app ? "app" : "email");
  const [pending, setPending] = useState(false);
  const [trust, setTrust] = useState(false);
  const [failure, setFailure] = useState<CodeFailure | undefined>();
  const [notice, setNotice] = useState<Notice>(
    app || sent ? undefined : "not_sent"
  );
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const code = String(new FormData(event.currentTarget).get("code") ?? "");
      setFailure(undefined);
      setNotice(undefined);
      setPending(true);
      verifyCode({ code, trust }, method).then(
        (result) => {
          setPending(false);
          if (result.ok) {
            onSignedIn();
          } else {
            setFailure(result.failure);
          }
        },
        () => {
          setPending(false);
          setFailure("unavailable");
        }
      );
    },
    [method, onSignedIn, trust]
  );
  // A new emailed code: the resend button, or the way from the app to email.
  const emailCode = useCallback(() => {
    setFailure(undefined);
    setNotice(undefined);
    sendCode().then(
      (result) => {
        if (result.ok) {
          setNotice(method === "email" ? "resent" : undefined);
          setMethod("email");
        } else if (result.failure === "expired") {
          onRestart();
        } else {
          setNotice("not_sent");
          setMethod("email");
        }
      },
      () => {
        setNotice("not_sent");
        setMethod("email");
      }
    );
  }, [method, onRestart]);
  const switchTo = useCallback((next: CodeMethod) => {
    setFailure(undefined);
    setNotice(undefined);
    setMethod(next);
  }, []);
  const failureText =
    failure === "wrong_code" && method === "backup"
      ? t("auth_code_backup_wrong")
      : failure && t(failureMessage[failure]);
  return (
    <AuthPage title={t("auth_code_title")}>
      <form
        data-method={method}
        data-slot="code-form"
        method="post"
        onSubmit={submit}
      >
        <FieldGroup>
          <p className="text-muted-foreground text-sm">
            {t(methodText[method].intro)}
          </p>
          <Field>
            <FieldLabel htmlFor="code">
              {t(methodText[method].label)}
            </FieldLabel>
            {/* Keyed on the method, so a code typed for one is not sent as another. */}
            {method === "backup" ? (
              <Input
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                autoFocus
                className="tracking-wider"
                id="code"
                key={method}
                name="code"
                required
                spellCheck={false}
                variant="token"
              />
            ) : (
              <Input
                autoComplete="one-time-code"
                autoFocus
                className="tracking-widest"
                id="code"
                inputMode="numeric"
                key={method}
                maxLength={6}
                name="code"
                required
                variant="token"
              />
            )}
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              checked={trust}
              data-slot="trust-browser"
              id="trust"
              onCheckedChange={setTrust}
            />
            <FieldLabel htmlFor="trust">{t("auth_code_trust")}</FieldLabel>
          </Field>
          {failureText ? <FieldError>{failureText}</FieldError> : null}
          {notice === "resent" ? (
            <output className="text-muted-foreground text-sm">
              {t("auth_code_resent")}
            </output>
          ) : null}
          {notice === "not_sent" ? (
            <FieldError>{t("auth_code_not_sent")}</FieldError>
          ) : null}
          {failure === "start_over" ? (
            <Button data-slot="sign-in-again" onClick={onRestart} type="button">
              {t("auth_code_sign_in_again")}
            </Button>
          ) : (
            <Button disabled={pending} type="submit">
              {pending ? t("auth_signing_in") : t("auth_code_submit")}
            </Button>
          )}
          <OtherWays
            app={app}
            email={email}
            method={method}
            onEmail={emailCode}
            onSwitch={switchTo}
          />
        </FieldGroup>
      </form>
    </AuthPage>
  );
}

/** The ways to the other methods under the button: a new emailed code, the app, a backup code, as each applies. */
function OtherWays({
  app,
  email,
  method,
  onEmail,
  onSwitch,
}: {
  readonly app: boolean;
  readonly email: boolean;
  readonly method: CodeMethod;
  readonly onEmail: () => void;
  readonly onSwitch: (method: CodeMethod) => void;
}): ReactNode {
  const { t } = useMessages();
  const ways: { slot: string; text: string; run: () => void }[] = [];
  if (method === "email") {
    ways.push({
      run: onEmail,
      slot: "resend-code",
      text: t("auth_code_resend"),
    });
  }
  if (app && method !== "app") {
    ways.push({
      run: () => onSwitch("app"),
      slot: "use-app",
      text: t("auth_code_use_app"),
    });
  }
  if (app && method !== "backup") {
    ways.push({
      run: () => onSwitch("backup"),
      slot: "use-backup",
      text: t("auth_code_use_backup"),
    });
  }
  if (email && method !== "email") {
    ways.push({
      run: onEmail,
      slot: "use-email",
      text: t("auth_code_use_email"),
    });
  }
  return ways.map((way) => (
    <Button
      data-slot={way.slot}
      key={way.slot}
      onClick={way.run}
      type="button"
      variant="ghost"
    >
      {way.text}
    </Button>
  ));
}
