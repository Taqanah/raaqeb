/**
 * Install: the command is the section. One block offers the three ways in,
 * Linux and macOS, Windows and Docker, each with its command on one line and
 * a button that copies it; the three steps from there to a status page follow
 * as words, and the way into the docs closes the page.
 */
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useId,
  useState,
} from "react";
import type { Locale } from "@/shared/i18n/locale.ts";
import { type Copy, docsPath, type InstallWay, installs } from "~/copy.ts";
import { CodeLine, chosenValue, Section } from "./section.tsx";

const ways: readonly InstallWay[] = ["unix", "windows", "docker"];

export function Install({
  copy,
  locale,
}: {
  readonly copy: Copy;
  readonly locale: Locale;
}): ReactNode {
  const i = copy.install;
  const [way, setWay] = useState<InstallWay>("unix");
  const name = useId();
  const choose = useCallback((e: ChangeEvent<HTMLFieldSetElement>) => {
    const next = ways.find((each) => each === chosenValue(e));
    if (next) {
      setWay(next);
    }
  }, []);
  return (
    <Section id="start" lead={i.lead} title={i.title}>
      <div className="mt-16 overflow-hidden rounded-xl bg-surface shadow-[0_24px_48px_-28px_oklch(0%_0_0/0.35)] ring-line">
        <fieldset
          aria-label={copy.hero.install}
          className="flex overflow-x-auto border-line-2 border-b px-3 [scrollbar-width:none] max-sm:px-1.5"
          onChange={choose}
        >
          {ways.map((each) => (
            <label
              className="relative flex h-12 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-md px-3 font-medium text-[15px] text-muted transition-colors after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-teal after:opacity-0 after:transition-opacity hover:text-fg has-checked:text-fg has-focus-visible:ring-2 has-focus-visible:ring-focus has-focus-visible:ring-inset has-checked:after:opacity-100 max-sm:px-2.5 max-sm:text-[14px] max-sm:after:inset-x-2.5"
              key={each}
            >
              <input
                checked={way === each}
                className="sr-only"
                name={name}
                readOnly
                type="radio"
                value={each}
              />
              {i.choices[each].name}
            </label>
          ))}
        </fieldset>
        <CodeLine
          className="flex items-center gap-2 py-5 ps-6 pe-3 text-[14px] max-sm:py-4 max-sm:ps-4 max-sm:pe-2 max-sm:text-[13px] rtl:ps-2 max-sm:rtl:ps-0"
          code={installs[way].code}
          copied={copy.command.copied}
          copy={copy.command.copy}
          // A new command starts with its button saying copy again.
          key={way}
          prompt={installs[way].prompt}
        />
        <p className="border-line-2 border-t px-6 py-4 text-[15px] leading-[1.6] max-sm:px-4">
          {i.choices[way].note}
        </p>
      </div>
      <ol className="mt-14 grid grid-cols-3 gap-x-8 gap-y-8 max-md:grid-cols-1">
        {i.steps.map(([title, text]) => (
          <li className="border-line border-t pt-6" key={title}>
            <h3 className="font-medium text-[20px] tracking-[-0.01em] [&:lang(ar)]:tracking-normal">
              {title}
            </h3>
            <p className="mt-2 text-[16px] leading-[1.6]">{text}</p>
          </li>
        ))}
      </ol>
      <div className="mt-14">
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
