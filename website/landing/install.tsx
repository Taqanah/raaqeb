/**
 * Install: from one command to a status page in three pictures side
 * by side, each the step itself: the commands on the server or in Docker,
 * the onboarding screen, and the status page that comes of it. The way into
 * the docs closes the page.
 */
import type { ReactNode } from "react";
import type { Locale } from "@/shared/i18n/locale.ts";
import { type Copy, dockerCommand, docsPath, installCommand } from "~/copy.ts";
import { Shot } from "./admin.tsx";
import { CodeLine, Section } from "./section.tsx";
import { StatusPage } from "./status-page.tsx";

export function Install({
  copy,
  locale,
}: {
  readonly copy: Copy;
  readonly locale: Locale;
}): ReactNode {
  const i = copy.install;
  return (
    <Section id="start" lead={i.lead} title={i.title}>
      <ol className="mt-16 grid grid-cols-3 gap-x-8 gap-y-14 max-lg:grid-cols-1">
        <Step text={i.steps[0][1]} title={i.steps[0][0]}>
          <div className="flex h-full flex-col justify-center gap-5 rounded-xl bg-surface p-5 shadow-[0_24px_48px_-28px_oklch(0%_0_0/0.35)] ring-line">
            <div>
              <p className="mb-1.5 font-medium text-[13px]">{i.script}</p>
              <CodeLine
                className="flex items-start gap-3 text-[14px]"
                code={installCommand}
                copied={copy.command.copied}
                copy={copy.command.copy}
                wrap
              />
            </div>
            <div className="border-line-2 border-t pt-4">
              <p className="mb-1.5 font-medium text-[13px]">{i.docker}</p>
              <CodeLine
                className="flex items-start gap-3 text-[14px]"
                code={dockerCommand}
                copied={copy.command.copied}
                copy={copy.command.copy}
                wrap
              />
            </div>
          </div>
        </Step>
        <Step text={i.steps[1][1]} title={i.steps[1][0]}>
          <div className="edge h-full overflow-hidden rounded-xl bg-surface shadow-[0_24px_48px_-28px_oklch(0%_0_0/0.35)]">
            <Shot
              alt={i.steps[1][0]}
              className="h-full"
              locale={locale}
              screen="onboarding"
            />
          </div>
        </Step>
        <Step text={i.steps[2][1]} title={i.steps[2][0]}>
          <div className="h-full overflow-hidden rounded-xl shadow-[0_24px_48px_-28px_oklch(0%_0_0/0.35)] ring-line">
            <StatusPage compact lang={locale} />
          </div>
        </Step>
      </ol>
      <div className="mt-16 flex flex-wrap items-center gap-x-6 gap-y-3">
        <a
          className="inline-flex h-12 items-center whitespace-nowrap rounded-lg bg-action px-6 font-medium text-[16px] text-action-fg transition-transform hover:-translate-y-px active:translate-y-0"
          href={`${docsPath[locale]}/get-started`}
        >
          {copy.footer.start}{" "}
          <span aria-hidden="true">{locale === "ar" ? " ←" : " →"}</span>
        </a>
      </div>
    </Section>
  );
}

/** One step: its picture in a frame of a shared height, then its title and its line. */
function Step({
  children,
  text,
  title,
}: {
  readonly children: ReactNode;
  readonly text: string;
  readonly title: string;
}): ReactNode {
  return (
    <li className="flex flex-col">
      <div className="h-[260px]">{children}</div>
      <h3 className="mt-7 font-medium text-[24px] tracking-[-0.01em]">
        {title}
      </h3>
      <p className="mt-2 max-w-[30em] text-[16px] text-strong">{text}</p>
    </li>
  );
}
