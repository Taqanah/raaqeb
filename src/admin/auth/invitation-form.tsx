/**
 * The invitation page (CONTEXT.md "Invitation"): the address and role its
 * link offers, and the name and password that accept it and sign in. A
 * closed link (used, revoked, expired or never one) shows no form, only
 * what to do instead; the endpoint checks the link again.
 */
import { Link, useHydrated } from "@tanstack/react-router";
import {
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { roleWords } from "@/admin/shell/role-words.ts";
import { useFocusRefused } from "@/admin/shell/use-focus-refused.ts";
import { acceptInvitation } from "@/shared/api/auth.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { passwordMaxLength, passwordMinLength } from "@/shared/schemas/auth.ts";
import type { SsoOffer } from "@/shared/schemas/sso.ts";
import {
  type InvitationAcceptFailure,
  type InvitationView,
  invitationAcceptSchema,
} from "@/shared/schemas/team.ts";
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
import { ProviderButton } from "./provider-button.tsx";

const failures = {
  already_member: "team_invitation_already_member",
  closed: "team_invitation_closed",
  rate_limited: "team_invitation_rate_limited",
  sso_required: "team_invitation_sso_only",
  unavailable: "team_invitation_unavailable",
} as const satisfies Record<InvitationAcceptFailure, string>;

export interface InvitationFormProps {
  readonly onAccepted: () => void;
  /** The identity provider's button, while single sign-on is on. */
  readonly sso?: SsoOffer;
  readonly token: string;
  readonly view: InvitationView;
}

export function InvitationForm({
  onAccepted,
  sso,
  token,
  view,
}: InvitationFormProps): ReactNode {
  const { t } = useMessages();
  const [pending, setPending] = useState(false);
  // Before hydration a press would post the form natively and come back empty, losing what was typed.
  const hydrated = useHydrated();
  const [failure, setFailure] = useState<InvitationAcceptFailure | undefined>(
    view.ok ? undefined : "closed"
  );
  // A new object per refused submit, so each one moves the focus to the field.
  const [refused, setRefused] = useState({ name: false, password: false });
  const formRef = useRef<HTMLFormElement>(null);
  useFocusRefused(formRef, refused);
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const input = {
        name: String(form.get("name") ?? "").trim(),
        password: String(form.get("password") ?? ""),
        token,
      };
      const name = !invitationAcceptSchema.shape.name.safeParse(input.name)
        .success;
      const password = !invitationAcceptSchema.shape.password.safeParse(
        input.password
      ).success;
      setRefused({ name, password });
      setFailure(undefined);
      if (name || password) {
        return;
      }
      setPending(true);
      acceptInvitation(input).then(
        (result) => {
          if (result.ok) {
            onAccepted();
            return;
          }
          setPending(false);
          setFailure(result.failure);
        },
        () => {
          setPending(false);
          setFailure("unavailable");
        }
      );
    },
    [onAccepted, token]
  );
  // A link that cannot work offers only the way on: someone sends a new one, or the account signs in.
  if (!view.ok || failure === "closed" || failure === "already_member") {
    return (
      <AuthPage title={t("team_invitation_title")}>
        <FieldGroup>
          <FieldError data-slot="invitation-closed">
            {t(failures[failure ?? "closed"])}
          </FieldError>
          <Button render={<Link preload={false} to="/sign-in" />}>
            {t("auth_sign_in")}
          </Button>
        </FieldGroup>
      </AuthPage>
    );
  }
  const offered = (
    <>
      <p className="text-muted-foreground text-sm">
        {t("team_invitation_intro")}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("auth_email")}</dt>
        <dd>
          <Token data-slot="invitation-email">{view.email}</Token>
        </dd>
        <dt className="text-muted-foreground">{t("team_invitation_as")}</dt>
        <dd data-role={view.role} data-slot="invitation-role">
          {t(roleWords[view.role].name)}
        </dd>
      </dl>
    </>
  );
  // Once single sign-on is required, only an owner's invitation sets a password.
  if (sso?.requireSso && view.role !== "owner") {
    return (
      <AuthPage title={t("team_invitation_title")}>
        <FieldGroup>
          {offered}
          <ProviderButton name={sso.name} />
          <FieldDescription>{t("team_invitation_sso_only")}</FieldDescription>
        </FieldGroup>
      </AuthPage>
    );
  }
  return (
    <AuthPage title={t("team_invitation_title")}>
      <form
        data-slot="invitation-form"
        method="post"
        noValidate
        onSubmit={submit}
        ref={formRef}
      >
        <FieldGroup>
          {offered}
          {sso ? (
            <>
              <ProviderButton name={sso.name} />
              <p className="text-center text-muted-foreground text-sm">
                {t("team_invitation_or_password")}
              </p>
            </>
          ) : null}
          <Field>
            <FieldLabel htmlFor="name">{t("team_name")}</FieldLabel>
            <Input
              aria-invalid={refused.name ? true : undefined}
              autoComplete="name"
              autoFocus
              id="name"
              maxLength={100}
              name="name"
              required
            />
            {refused.name ? (
              <FieldError data-error-for="name">
                {t("team_name_required")}
              </FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="password">{t("auth_password")}</FieldLabel>
            <Input
              aria-invalid={refused.password ? true : undefined}
              autoComplete="new-password"
              id="password"
              maxLength={passwordMaxLength}
              minLength={passwordMinLength}
              name="password"
              required
              type="password"
            />
            <FieldDescription>
              {t("team_invitation_password_note")}
            </FieldDescription>
            {refused.password ? (
              <FieldError data-error-for="password">
                {t("auth_password_length")}
              </FieldError>
            ) : null}
          </Field>
          {failure ? <FieldError>{t(failures[failure])}</FieldError> : null}
          <Button
            data-slot="invitation-accept"
            disabled={pending || !hydrated}
            type="submit"
          >
            {pending ? t("app_saving") : t("team_invitation_accept")}
          </Button>
        </FieldGroup>
      </form>
    </AuthPage>
  );
}
