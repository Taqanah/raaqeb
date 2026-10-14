/**
 * The getting-started checklist (CONTEXT.md "Getting-started checklist"):
 * one card above the monitors list with the four steps, the first
 * three in the order they depend on each other, each ticked once its thing exists and linking
 * to its form while open. The card closes for good the first time every step
 * is done, or when the operator dismisses it.
 */
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useRef, useState } from "react";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { GettingStarted } from "@/shared/schemas/monitor.ts";
import type { SaveResult } from "@/shared/schemas/settings.ts";
import { Button } from "@/shared/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { CheckIcon, ChevronEndIcon, XIcon } from "@/shared/ui/icons.tsx";

const steps: readonly {
  readonly line: keyof GettingStarted;
  readonly label: MessageId;
  readonly to: string;
}[] = [
  {
    label: "monitor_getting_started_monitor",
    line: "monitor",
    to: "/admin/monitors/new",
  },
  {
    label: "monitor_getting_started_link",
    line: "link",
    to: "/admin/components/new",
  },
  {
    label: "monitor_getting_started_published",
    line: "published",
    to: "/admin/pages/new",
  },
  {
    label: "monitor_getting_started_channel",
    line: "channel",
    to: "/admin/channels/new",
  },
];

export function GettingStartedCard({
  dismiss,
  lines,
}: {
  /** Stores the dismissal; the page reads the list again once it is stored. */
  readonly dismiss: () => Promise<SaveResult | undefined>;
  readonly lines: GettingStarted;
}): ReactNode {
  const { t } = useMessages();
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const onDismiss = useCallback(async () => {
    // What follows the card stays when it goes; its first control takes the focus the dismiss button held.
    const next = card.current?.nextElementSibling;
    setPending(true);
    const result = await dismiss().catch(() => undefined);
    setPending(false);
    setRefused(result?.ok !== true);
    if (result?.ok) {
      next
        ?.querySelector<HTMLElement>("a[href], button, input, select")
        ?.focus();
    }
  }, [dismiss]);
  return (
    <Card data-slot="getting-started" ref={card}>
      {/* The title alone, no description, so the card above a list is as short as it can be. */}
      <CardHeader className="grid-cols-[1fr_auto] items-center">
        <CardTitle>{t("monitor_getting_started_title")}</CardTitle>
        <Button
          aria-label={t("monitor_getting_started_dismiss")}
          className="-my-2 -me-2"
          data-slot="dismiss-getting-started"
          disabled={pending}
          onClick={onDismiss}
          size="icon"
          title={t("monitor_getting_started_dismiss")}
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ol className="flex flex-col divide-y">
          {steps.map(({ label, line, to }) => {
            const done = lines[line];
            return (
              <li
                className="flex min-h-control items-center gap-3 py-1"
                data-done={done}
                data-line={line}
                key={line}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full",
                    done
                      ? "bg-status-up text-card"
                      : "border-2 border-border-strong"
                  )}
                >
                  {done ? (
                    <CheckIcon className="size-3" strokeWidth={3} />
                  ) : null}
                </span>
                {done ? (
                  <span className="text-muted-foreground">
                    {t(label)}
                    <span className="sr-only">
                      {" "}
                      {t("monitor_getting_started_done")}
                    </span>
                  </span>
                ) : (
                  <Link
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-sm font-medium hover:underline"
                    to={to}
                  >
                    {t(label)}
                    <ChevronEndIcon className="size-icon shrink-0 text-muted-foreground" />
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
        {refused ? (
          <p className="text-destructive text-sm" role="alert">
            {t("monitor_unavailable")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
