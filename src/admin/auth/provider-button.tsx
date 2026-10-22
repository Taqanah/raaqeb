/**
 * The identity provider's button on the sign-in and invitation pages:
 * "Continue with <name>" asks Better Auth for the provider's address and
 * sends the browser there; the provider sends it back to the admin area,
 * or to the sign-in page with the reason it was refused.
 */
import { useHydrated } from "@tanstack/react-router";
import { type ReactNode, useCallback, useState } from "react";
import { startProviderSignIn } from "@/shared/api/auth.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Button } from "@/shared/ui/button.tsx";
import { FieldError } from "@/shared/ui/field.tsx";

export function ProviderButton({
  name,
}: {
  /** The provider's name as the owner gave it. */
  readonly name: string;
}): ReactNode {
  const { t } = useMessages();
  const [pending, setPending] = useState(false);
  // Before hydration a press would do nothing and need a second one.
  const hydrated = useHydrated();
  const [failure, setFailure] = useState<
    "rate_limited" | "unavailable" | undefined
  >(undefined);
  const start = useCallback(() => {
    setPending(true);
    setFailure(undefined);
    startProviderSignIn().then(
      (result) => {
        if (result.ok) {
          location.assign(result.url);
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
  }, []);
  return (
    <div className="flex flex-col gap-2">
      <Button
        data-slot="sso-sign-in"
        disabled={pending || !hydrated}
        onClick={start}
        type="button"
        variant="outline"
      >
        {t("auth_sso_continue", { name })}
      </Button>
      {failure === undefined ? null : (
        <FieldError data-failure={failure}>
          {t(
            failure === "rate_limited"
              ? "auth_rate_limited"
              : "auth_unavailable"
          )}
        </FieldError>
      )}
    </div>
  );
}
