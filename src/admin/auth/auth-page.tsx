/**
 * The frame the sign-in and sign-out pages share: one centred card under the
 * install's name, the language switcher below it unless the card itself
 * chooses the language.
 */
import type { ReactNode } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { LocaleSwitcher } from "@/shared/ui/locale-switcher.tsx";

export interface AuthPageProps {
  readonly children: ReactNode;
  /** Kept for screen readers but not shown, where the card's button already says it (sign-in). */
  readonly hideTitle?: boolean;
  /** Where onboarding is: shown above the title as "step 1 of 3". */
  readonly step?: { readonly current: number; readonly total: number };
  /** Whether the language links sit under the card; off where the card is the language choice. */
  readonly switcher?: boolean;
  readonly title: string;
}

export function AuthPage({
  children,
  hideTitle = false,
  step,
  switcher = true,
  title,
}: AuthPageProps): ReactNode {
  const { locale, t } = useMessages();
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6">
      <h1 className="font-semibold text-lg">{t("app_name")}</h1>
      <Card className="w-full max-w-sm">
        {/* 28 px under the title against 20 px between the fields, so the title heads the card rather than the first field. */}
        {hideTitle ? null : (
          <CardHeader className="pb-3">
            {step ? (
              <StepLines current={step.current} total={step.total} />
            ) : null}
            <CardTitle>{title}</CardTitle>
          </CardHeader>
        )}
        <CardContent>
          {/* Hidden, it sits in the content so the card keeps even padding. */}
          {hideTitle ? <h2 className="sr-only">{title}</h2> : null}
          {children}
        </CardContent>
      </Card>
      {switcher ? <LocaleSwitcher current={locale} /> : null}
    </main>
  );
}

/**
 * Onboarding's steps as a row of lines from the start side: a finished step green, the current one dark, one ahead grey.
 * The words "step 1 of 3" stay for screen readers.
 */
function StepLines({
  current,
  total,
}: {
  readonly current: number;
  readonly total: number;
}): ReactNode {
  const { t } = useMessages();
  return (
    <div className="mb-2" data-current={current} data-slot="onboarding-step">
      <p className="sr-only">{t("onboarding_step", { current, total })}</p>
      <ol aria-hidden="true" className="flex gap-1.5">
        {Array.from({ length: total }, (_, index) => index + 1).map((each) => {
          const state = stateOf(each, current);
          return (
            <li
              className={cn("h-1 flex-1 rounded-full", lineColour[state])}
              data-state={state}
              key={each}
            />
          );
        })}
      </ol>
    </div>
  );
}

export type StepState = "done" | "current" | "ahead";

const lineColour: Readonly<Record<StepState, string>> = {
  ahead: "bg-border-strong",
  current: "bg-primary",
  done: "bg-status-up",
};

/** A step against the one the operator is on. */
export function stateOf(step: number, current: number): StepState {
  if (step < current) {
    return "done";
  }
  return step === current ? "current" : "ahead";
}
