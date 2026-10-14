/**
 * The sign-in form: email, password, one primary button, the
 * "forgot password" link that always shows, and the failure line rendered
 * from its code. Posts through the shared api client and, once the cookie is
 * set, moves to the admin area. With the second step on, the password opens
 * the code form instead: the authenticator app's code when one is set up,
 * else the emailed code, sent at once. Refused by
 * the origin check, it shows the command that makes this address the public
 * address, the way back in for an operator who means it.
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
import { sendCode, signIn } from "@/shared/api/auth.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  passwordMaxLength,
  passwordMinLength,
  type SignInFailure,
  type SignInInput,
  signInSchema,
} from "@/shared/schemas/auth.ts";
import { Button } from "@/shared/ui/button.tsx";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { AuthPage } from "./auth-page.tsx";
import { CodeForm } from "./code-form.tsx";
import { SetAddressCommand } from "./set-address-command.tsx";

export interface SignInFormProps {
  /** An email channel exists, so the second step can email a code. */
  readonly email: boolean;
  /** Where a successful sign-in lands. */
  readonly onSignedIn: () => void;
}

const failureMessage = {
  invalid_credentials: "auth_invalid_credentials",
  origin_refused: "auth_origin_refused",
  rate_limited: "auth_rate_limited",
  unavailable: "auth_unavailable",
} as const;

// The link is always shown; the page decides between the form and the command.
const forgotPasswordPath = "/forgot-password";

export function SignInForm({ email, onSignedIn }: SignInFormProps): ReactNode {
  const { t } = useMessages();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<SignInFailure | undefined>();
  // The second step is due: the app's code is asked, or whether the first emailed code went out.
  const [secondStep, setSecondStep] = useState<
    { app: boolean; sent: boolean } | undefined
  >();
  const restart = useCallback(() => setSecondStep(undefined), []);
  // A malformed email or an empty password is refused beside its field; any other password is the server's to judge.
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  const formRef = useRef<HTMLFormElement>(null);
  useFocusRefused(formRef, refused);
  const attempt = useCallback(
    async (input: SignInInput) => {
      setFailure(undefined);
      setPending(true);
      const result = await signIn(input).catch(
        () => ({ failure: "unavailable", ok: false }) as const
      );
      if (result.ok && result.secondStep && result.app) {
        // The app's code is asked first; nothing is emailed unless asked for.
        setPending(false);
        setSecondStep({ app: true, sent: false });
      } else if (result.ok && result.secondStep) {
        // The code goes out at once; the form offers a new one.
        const sent = await sendCode().catch(() => undefined);
        setPending(false);
        setSecondStep({ app: false, sent: sent?.ok === true });
      } else if (result.ok) {
        setPending(false);
        onSignedIn();
      } else {
        setPending(false);
        setFailure(result.failure);
      }
    },
    [onSignedIn]
  );
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const input = {
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      };
      const fields = new Set<string>();
      if (!signInSchema.shape.email.safeParse(input.email).success) {
        fields.add("email");
      }
      if (input.password === "") {
        fields.add("password");
      }
      setRefused(fields);
      if (fields.size > 0) {
        setFailure(undefined);
        return;
      }
      attempt(input).catch(() => undefined);
    },
    [attempt]
  );
  if (secondStep) {
    return (
      <CodeForm
        app={secondStep.app}
        email={email}
        onRestart={restart}
        onSignedIn={onSignedIn}
        sent={secondStep.sent}
      />
    );
  }
  return (
    <AuthPage hideTitle title={t("auth_sign_in_title")}>
      <form method="post" noValidate onSubmit={submit} ref={formRef}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email">{t("auth_email")}</FieldLabel>
            <Input
              aria-invalid={refused.has("email") ? true : undefined}
              autoComplete="email"
              autoFocus
              dir="ltr"
              id="email"
              name="email"
              required
              type="email"
            />
            {refused.has("email") ? (
              <FieldError data-error-for="email">
                {t("auth_email_invalid")}
              </FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="password">{t("auth_password")}</FieldLabel>
            <Input
              aria-invalid={refused.has("password") ? true : undefined}
              autoComplete="current-password"
              id="password"
              maxLength={passwordMaxLength}
              minLength={passwordMinLength}
              name="password"
              required
              type="password"
            />
            {refused.has("password") ? (
              <FieldError data-error-for="password">
                {t("auth_password_required")}
              </FieldError>
            ) : null}
          </Field>
          {failure ? (
            <FieldError>{t(failureMessage[failure])}</FieldError>
          ) : null}
          {failure === "origin_refused" ? <SetAddressCommand /> : null}
          <Button disabled={pending} type="submit">
            {pending ? t("auth_signing_in") : t("auth_sign_in")}
          </Button>
          <Link
            className="text-center text-muted-foreground text-sm underline-offset-4 hover:underline"
            // Preload is for the signed-in admin only: a hover here would send requests for a visitor.
            preload={false}
            to={forgotPasswordPath}
          >
            {t("auth_forgot_password")}
          </Link>
        </FieldGroup>
      </form>
    </AuthPage>
  );
}
