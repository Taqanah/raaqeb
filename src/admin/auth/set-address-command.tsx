/**
 * What sign-in and sign-out show under the origin check's refusal: the
 * command that makes the address the browser is at the public address, the
 * way back in for an operator who means it.
 */
import { type ReactNode, useEffect, useState } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Token } from "@/shared/ui/token.tsx";

export function SetAddressCommand(): ReactNode {
  const { t } = useMessages();
  // Read after mount, never during render (ADR-0006).
  const [here, setHere] = useState("");
  useEffect(() => {
    setHere(window.location.origin);
  }, []);
  return (
    <div className="flex flex-col gap-2 text-muted-foreground text-sm">
      <p>{t("auth_origin_set_address")}</p>
      {/* One click selects the whole command for copying; a long address wraps inside the card on a phone. */}
      <Token
        className="wrap-anywhere block select-all whitespace-pre-wrap px-3 py-2"
        data-slot="set-address-command"
      >
        {`raaqeb set-address ${here}`}
      </Token>
    </div>
  );
}
