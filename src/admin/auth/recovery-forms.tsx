/**
 * Password recovery's pages: the request form when the install
 * has an email channel, the no-email page with the reset command otherwise,
 * and the set-new-password form the reset link opens. No sign-in follows a
 * reset; the operator signs in with the new password.
 */
import { Link } from "@tanstack/react-router";
import {
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { useFocusRefused } from "@/admin/shell/use-focus-refused.ts";
import { requestReset, resetPassword } from "@/shared/api/auth.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  passwordMaxLength,
  passwordMinLength,
  type ResetFailure,
  type ResetRequestFailure,
  resetPasswordSchema,
  resetRequestSchema,
} from "@/shared/schemas/auth.ts";
import { Button } from "@/shared/ui/button.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { AuthPage } from "./auth-page.tsx";

/** The command the no-email page shows; its flags are the reset command's own. */
export const resetCommand = "raaqeb reset-password";

const signInPath = "/sign-in";
const forgotPath = "/forgot-password";

const requestFailures = {
  rate_limited: "auth_rate_limited",
  unavailable: "auth_unavailable",
} as const satisfies Record<ResetRequestFailure, string>;

const resetFailures = {
  invalid_link: "auth_reset_invalid_link",
  rate_limited: "auth_rate_limited",
  unavailable: "auth_unavailable",
} as const satisfies Record<ResetFailure, string>;

function BackToSignIn(): ReactNode {
  const { t } = useMessages();
  return (
    <Link
      className="text-center text-muted-foreground text-sm underline-offset-4 hover:underline"
      // Preload is for the signed-in admin only: a hover here would send requests for a visitor.
      preload={false}
      to={signInPath}
    >
      {t("auth_back_to_sign_in")}
    </Link>
  );
}

/** The reset command in a left-to-right block; one click selects the whole command for copying, no script needed. */
function ResetCommand(): ReactNode {
  return (
    <Token
      className="block select-all whitespace-pre px-3 py-2"
      data-slot="reset-command"
    >
      {resetCommand}
    </Token>
  );
}

/** "Forgot password" with an email channel: the address, then "check your email", which never says whether it is the account's, and the command for mail that never comes. */
export function ForgotForm(): ReactNode {
  const { t } = useMessages();
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<ResetRequestFailure | undefined>();
  // A new object per refused submit, so each one moves the focus to the field.
  const [refused, setRefused] = useState<{ email: boolean }>({ email: false });
  const formRef = useRef<HTMLFormElement>(null);
  useFocusRefused(formRef, refused);
  const submit = useCallback((event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    const malformed = !resetRequestSchema.safeParse({ email }).success;
    setRefused({ email: malformed });
    setFailure(undefined);
    if (malformed) {
      return;
    }
    setPending(true);
    requestReset({ email }).then(
      (result) => {
        setPending(false);
        if (result.ok) {
          setSent(true);
        } else {
          setFailure(result.failure);
        }
      },
      () => {
        setPending(false);
        setFailure("unavailable");
      }
    );
  }, []);
  return (
    <AuthPage title={t("auth_forgot_title")}>
      {sent ? (
        <FieldGroup>
          <output className="text-sm" data-slot="reset-sent">
            {t("auth_forgot_sent")}
          </output>
          <p className="text-muted-foreground text-sm">
            {t("auth_forgot_no_mail")}
          </p>
          <ResetCommand />
          <BackToSignIn />
        </FieldGroup>
      ) : (
        <form method="post" noValidate onSubmit={submit} ref={formRef}>
          <FieldGroup>
            <p className="text-muted-foreground text-sm">
              {t("auth_forgot_intro")}
            </p>
            <Field>
              <FieldLabel htmlFor="email">{t("auth_email")}</FieldLabel>
              <Input
                aria-invalid={refused.email ? true : undefined}
                autoComplete="email"
                autoFocus
                dir="ltr"
                id="email"
                name="email"
                required
                type="email"
              />
              {refused.email ? (
                <FieldError data-error-for="email">
                  {t("auth_email_invalid")}
                </FieldError>
              ) : null}
            </Field>
            {failure ? (
              <FieldError>{t(requestFailures[failure])}</FieldError>
            ) : null}
            <Button disabled={pending} type="submit">
              {pending ? t("auth_sending") : t("auth_forgot_submit")}
            </Button>
            <BackToSignIn />
          </FieldGroup>
        </form>
      )}
    </AuthPage>
  );
}

/** "Forgot password" without email: the reset command in a left-to-right block, and what it does. */
export function NoEmailPage(): ReactNode {
  const { t } = useMessages();
  return (
    <AuthPage title={t("auth_no_email_title")}>
      <FieldGroup>
        <p className="text-sm">{t("auth_no_email_intro")}</p>
        <ResetCommand />
        <p className="text-muted-foreground text-sm">
          {t("auth_no_email_prints")}
        </p>
        <BackToSignIn />
      </FieldGroup>
    </AuthPage>
  );
}

export interface ResetFormProps {
  /** Whether the link still sets a password: not used, not expired. */
  readonly open: boolean;
  /** The reset link's token; empty when the page was opened without one. */
  readonly token: string;
}

/** The set-new-password page: one new password, then a line that sends the operator to sign in. */
export function ResetForm({ open, token }: ResetFormProps): ReactNode {
  const { t } = useMessages();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ResetFailure | undefined>(
    open && token !== "" ? undefined : "invalid_link"
  );
  // A new object per refused submit, so each one moves the focus to the field.
  const [refused, setRefused] = useState<{ newPassword: boolean }>({
    newPassword: false,
  });
  const formRef = useRef<HTMLFormElement>(null);
  useFocusRefused(formRef, refused);
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const newPassword = String(
        new FormData(event.currentTarget).get("newPassword") ?? ""
      );
      const malformed =
        !resetPasswordSchema.shape.newPassword.safeParse(newPassword).success;
      setRefused({ newPassword: malformed });
      setFailure(undefined);
      if (malformed) {
        return;
      }
      setPending(true);
      resetPassword({ newPassword, token }).then(
        (result) => {
          setPending(false);
          if (result.ok) {
            setDone(true);
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
    [token]
  );
  if (done) {
    return (
      <AuthPage title={t("auth_reset_title")}>
        <FieldGroup>
          <output className="text-sm" data-slot="reset-done">
            {t("auth_reset_done")}
          </output>
          <Button render={<Link preload={false} to={signInPath} />}>
            {t("auth_sign_in")}
          </Button>
        </FieldGroup>
      </AuthPage>
    );
  }
  // A missing, used or expired link cannot be retried; only a new one helps.
  if (failure === "invalid_link") {
    return (
      <AuthPage title={t("auth_reset_title")}>
        <FieldGroup>
          <FieldError data-slot="reset-link-invalid">
            {t(resetFailures.invalid_link)}
          </FieldError>
          <Button render={<Link preload={false} to={forgotPath} />}>
            {t("auth_reset_ask_new")}
          </Button>
          <BackToSignIn />
        </FieldGroup>
      </AuthPage>
    );
  }
  return (
    <AuthPage title={t("auth_reset_title")}>
      <form method="post" noValidate onSubmit={submit} ref={formRef}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="newPassword">
              {t("auth_reset_new_password")}
            </FieldLabel>
            <Input
              aria-invalid={refused.newPassword ? true : undefined}
              autoComplete="new-password"
              autoFocus
              id="newPassword"
              maxLength={passwordMaxLength}
              minLength={passwordMinLength}
              name="newPassword"
              required
              type="password"
            />
            <FieldDescription>{t("auth_reset_note")}</FieldDescription>
            {refused.newPassword ? (
              <FieldError data-error-for="newPassword">
                {t("auth_password_length")}
              </FieldError>
            ) : null}
          </Field>
          {failure ? (
            <FieldError>{t(resetFailures[failure])}</FieldError>
          ) : null}
          <Button disabled={pending} type="submit">
            {pending ? t("app_saving") : t("auth_reset_submit")}
          </Button>
          <BackToSignIn />
        </FieldGroup>
      </form>
    </AuthPage>
  );
}
