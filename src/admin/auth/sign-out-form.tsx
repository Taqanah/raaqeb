/**
 * The sign-out page's one control: a button, because a GET must
 * never end a session. Posts through the shared api client and then moves to
 * the sign-in page.
 */
import { Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import {
  type MouseEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useState,
} from "react";
import { signOut } from "@/shared/api/auth.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { SignOutFailure } from "@/shared/schemas/auth.ts";
import { Button, buttonVariants } from "@/shared/ui/button.tsx";
import { cn } from "@/shared/ui/cn.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
} from "@/shared/ui/field.tsx";
import { AuthPage } from "./auth-page.tsx";
import { SetAddressCommand } from "./set-address-command.tsx";

/** The origin check's refusal is worded as at sign-in, with the same way back in. */
const failureMessage = {
  origin_refused: "auth_origin_refused",
  unavailable: "auth_unavailable",
} as const satisfies Record<SignOutFailure, MessageId>;

export interface SignOutFormProps {
  readonly onSignedOut: () => void;
}

export function SignOutForm({ onSignedOut }: SignOutFormProps): ReactNode {
  const { t } = useMessages();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<SignOutFailure | undefined>();
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFailure(undefined);
      setPending(true);
      // Only a confirmed sign-out moves on: the cookie is still a session until the server says otherwise.
      signOut().then(
        (done) => {
          setPending(false);
          if (done.ok) {
            onSignedOut();
          } else {
            setFailure(done.failure);
          }
        },
        () => {
          setPending(false);
          setFailure("unavailable");
        }
      );
    },
    [onSignedOut]
  );
  // Back to the page the sign-out was asked from; opened directly, the link's monitors page.
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const onCancel = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (canGoBack) {
        event.preventDefault();
        router.history.back();
      }
    },
    [canGoBack, router]
  );
  return (
    <AuthPage title={t("auth_sign_out")}>
      <form method="post" onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldDescription>{t("auth_sign_out_question")}</FieldDescription>
          </Field>
          {failure ? (
            <FieldError>{t(failureMessage[failure])}</FieldError>
          ) : null}
          {failure === "origin_refused" ? <SetAddressCommand /> : null}
          {/* A way back beside the confirm, red as the sidebar's sign-out is. */}
          <div className="flex gap-2">
            <Link
              className={cn(buttonVariants({ variant: "outline" }), "flex-1")}
              data-slot="sign-out-cancel"
              onClick={onCancel}
              to="/admin/monitors"
            >
              {t("app_cancel")}
            </Link>
            <Button
              className="flex-1"
              disabled={pending}
              type="submit"
              variant="destructive"
            >
              {pending ? t("auth_signing_out") : t("auth_sign_out")}
            </Button>
          </div>
        </FieldGroup>
      </form>
    </AuthPage>
  );
}
