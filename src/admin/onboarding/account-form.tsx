/**
 * The account screen: email, password and the public address
 * pre-filled with the browser's origin once mounted (the request's origin
 * before that), one editable field. An address the browser is not at is
 * stored only after the operator confirms it. The install language
 * stored is the locale this document is rendered in, which the language
 * screen chose and the switcher may have changed.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AuthPage } from "@/admin/auth/auth-page.tsx";
import { useFocusRefused } from "@/admin/shell/use-focus-refused.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { passwordMaxLength, passwordMinLength } from "@/shared/schemas/auth.ts";
import {
  type AccountRefusal,
  type OperatorAccountInput,
  operatorAccountSchema,
} from "@/shared/schemas/onboarding.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Button } from "@/shared/ui/button.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";

export type CreateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AccountRefusal };

export interface AccountFormProps {
  readonly create: (input: OperatorAccountInput) => Promise<CreateResult>;
  readonly onCreated: () => void;
  /** How many screens this install's onboarding has; the account screen is the last. */
  readonly steps: number;
  readonly suggestedAddress: string;
}

const refusalMessage: Readonly<Record<AccountRefusal, MessageId>> = {
  already_exists: "onboarding_account_already_exists",
  address_elsewhere: "onboarding_address_elsewhere",
  invalid: "onboarding_account_invalid",
  no_database: "onboarding_account_no_database",
  unavailable: "onboarding_unavailable",
};

export function AccountForm({
  create,
  onCreated,
  steps,
  suggestedAddress,
}: AccountFormProps): ReactNode {
  const { locale, t } = useMessages();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AccountRefusal | undefined>();
  const [address, setAddress] = useState(suggestedAddress);
  const [confirmed, setConfirmed] = useState(false);
  // The fields the last submit refused, each marked with its own words until the next submit.
  const [refused, setRefused] = useState<ReadonlySet<unknown>>(new Set());
  const formRef = useRef<HTMLFormElement>(null);
  useFocusRefused(formRef, refused);
  const elsewhere = failure === "address_elsewhere";

  // The browser knows the scheme and host it used, whatever the proxies in front told the server; read after mount (ADR-0006).
  useEffect(() => {
    setAddress(window.location.origin);
  }, []);

  const changeAddress = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setAddress(event.currentTarget.value);
    // The confirmation was for the address warned about, not this one.
    setFailure((current) =>
      current === "address_elsewhere" ? undefined : current
    );
    setConfirmed(false);
  }, []);

  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const parsed = operatorAccountSchema.safeParse({
        addressConfirmed: confirmed,
        email: String(form.get("email") ?? ""),
        locale,
        password: String(form.get("password") ?? ""),
        publicAddress: address.trim(),
      });
      if (!parsed.success) {
        setRefused(new Set(parsed.error.issues.map((issue) => issue.path[0])));
        setFailure("invalid");
        return;
      }
      setRefused(new Set());
      setFailure(undefined);
      setPending(true);
      create(parsed.data).then(
        (result) => {
          setPending(false);
          if (result.ok) {
            onCreated();
          } else {
            setFailure(result.reason);
          }
        },
        () => {
          setPending(false);
          setFailure("unavailable");
        }
      );
    },
    [address, confirmed, create, locale, onCreated]
  );

  return (
    <AuthPage
      step={{ current: steps, total: steps }}
      title={t("onboarding_account_title")}
    >
      <form method="post" noValidate onSubmit={submit} ref={formRef}>
        <FieldGroup>
          <FieldDescription>{t("onboarding_account_lead")}</FieldDescription>
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
              autoComplete="new-password"
              id="password"
              maxLength={passwordMaxLength}
              minLength={passwordMinLength}
              name="password"
              required
              type="password"
            />
            {refused.has("password") ? (
              <FieldError data-error-for="password">
                {t("auth_password_length")}
              </FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="publicAddress">
              {t("onboarding_public_address")}
            </FieldLabel>
            <Input
              aria-invalid={refused.has("publicAddress") ? true : undefined}
              autoComplete="url"
              id="publicAddress"
              name="publicAddress"
              onChange={changeAddress}
              required
              type="url"
              value={address}
              variant="token"
            />
            <FieldDescription>
              {t("onboarding_public_address_hint")}
            </FieldDescription>
            {refused.has("publicAddress") ? (
              <FieldError data-error-for="publicAddress">
                {t("setting_public_address_invalid")}
              </FieldError>
            ) : null}
          </Field>
          {elsewhere ? (
            <Alert data-slot="address-elsewhere">
              <AlertDescription>{t(refusalMessage[failure])}</AlertDescription>
              <Field className="mt-2" orientation="horizontal">
                <Checkbox
                  checked={confirmed}
                  id="addressConfirmed"
                  onCheckedChange={setConfirmed}
                />
                <FieldLabel htmlFor="addressConfirmed">
                  {t("onboarding_address_confirm")}
                </FieldLabel>
              </Field>
            </Alert>
          ) : null}
          {failure && !elsewhere ? (
            <FieldError>{t(refusalMessage[failure])}</FieldError>
          ) : null}
          <Button disabled={pending || (elsewhere && !confirmed)} type="submit">
            {pending
              ? t("onboarding_account_creating")
              : t("onboarding_account_create")}
          </Button>
        </FieldGroup>
      </form>
    </AuthPage>
  );
}
