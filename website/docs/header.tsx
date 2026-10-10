/**
 * The docs' header: the website's nav as one bar, the brand and the
 * docs' name, search, the other language in one click, the theme button and
 * GitHub. On a wide screen it sits above Fumadocs' layout; on a phone it
 * takes the layout's own header slot, so it holds the sidebar's menu button.
 */
import { useSearchContext } from "@fumadocs/base-ui/contexts/search";
import { useDocsLayout } from "@fumadocs/base-ui/layouts/docs";
import { type ReactNode, useCallback } from "react";
import type { Locale } from "@/shared/i18n/locale.ts";
import {
  ActivityIcon,
  PanelStartIcon,
  SearchIcon,
} from "@/shared/ui/icons.tsx";
import { copies, docsPath, repository } from "~/copy.ts";
import { LanguagesIcon } from "~/landing/icons.tsx";
import { Logo } from "~/landing/logos.tsx";
import { ThemeSwitch } from "~/landing/theme.tsx";
import { homePath } from "~/locale.ts";

export interface HeaderProps {
  readonly locale: Locale;
  /** The same page in the other language, or that language's docs when this page has no twin. */
  readonly otherUrl: string;
}

const quiet =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function Bar({
  children,
  className,
  locale,
  otherUrl,
}: HeaderProps & {
  readonly children?: ReactNode;
  readonly className: string;
}): ReactNode {
  const copy = copies[locale];
  const other = locale === "ar" ? "en" : "ar";
  const { setOpenSearch } = useSearchContext();
  const search = useCallback(() => setOpenSearch(true), [setOpenSearch]);
  return (
    <header className={className}>
      <a
        className="flex shrink-0 items-center gap-2 font-medium text-[15px]"
        href={homePath[locale]}
      >
        <span className="grid size-6 place-items-center rounded-md bg-action text-action-fg [&>svg]:size-3.5">
          <ActivityIcon />
        </span>
        {copy.brand}
      </a>
      <span className="h-4 w-px bg-line" />
      <a
        className="text-[14px] text-muted hover:text-fg"
        href={docsPath[locale]}
      >
        {copy.nav.docs}
      </a>
      <span className="flex-1" />
      <button
        className="flex h-9 w-64 cursor-pointer items-center gap-2 rounded-lg bg-soft px-3 text-[13px] text-muted transition-colors hover:text-fg max-md:hidden"
        onClick={search}
        type="button"
      >
        <SearchIcon className="size-4" />
        <span className="flex-1 text-start">{copy.search}</span>
        <kbd className="token text-[11px]">Ctrl K</kbd>
      </button>
      <button
        aria-label={copy.search}
        className={`${quiet} md:hidden`}
        onClick={search}
        type="button"
      >
        <SearchIcon className="size-4" />
      </button>
      <a className={quiet} href={otherUrl} lang={other}>
        <LanguagesIcon className="size-3.5" />
        <span className="max-sm:sr-only">{copy.other}</span>
      </a>
      <ThemeSwitch copy={copy.theme} />
      <a
        aria-label="GitHub"
        className={`${quiet} max-sm:hidden`}
        href={repository}
      >
        <Logo brand="github" className="size-4" />
      </a>
      {children}
    </header>
  );
}

const bar =
  "z-30 flex h-14 items-center gap-2 border-line border-b bg-bg/85 px-4 backdrop-blur-md md:px-6";

/** The wide screen's header, above the layout; the layout's sidebar and outline start under it. */
export function DocsHeader(props: HeaderProps): ReactNode {
  return <Bar {...props} className={`sticky top-0 max-md:hidden ${bar}`} />;
}

/** The phone's header, in the layout's header slot, with the button that opens the sidebar. */
export function DocsPhoneHeader(props: HeaderProps): ReactNode {
  const { slots } = useDocsLayout();
  const Trigger = slots.sidebar.trigger;
  return (
    <Bar
      {...props}
      className={`sticky top-0 h-(--fd-header-height) [grid-area:header] md:hidden max-md:layout:[--fd-header-height:--spacing(14)] ${bar}`}
    >
      <Trigger aria-label={copies[props.locale].nav.docs} className={quiet}>
        <PanelStartIcon className="size-4" />
      </Trigger>
    </Bar>
  );
}
