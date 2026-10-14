/** The landing page in one locale: the floating pill nav, the hero, the sections in that locale's order, the one-line footer. */
import type { ReactNode } from "react";
import type { Locale } from "@/shared/i18n/locale.ts";
import { ActivityIcon } from "@/shared/ui/icons.tsx";
import { copies, docsPath, repository, type Section } from "~/copy.ts";
import { homePath } from "~/locale.ts";
import { Admin } from "./admin.tsx";
import { Alerts } from "./alerts.tsx";
import { ArabicFirst } from "./arabic.tsx";
import { Checks } from "./checks.tsx";
import { Hero } from "./hero.tsx";
import { LanguagesIcon } from "./icons.tsx";
import { Install } from "./install.tsx";
import { Logo } from "./logos.tsx";
import { Pages } from "./pages.tsx";
import { Server } from "./server.tsx";
import { ThemeSwitch } from "./theme.tsx";
// Imported here, not by the route, so the landing page's stylesheet rides with its component alone and the docs pages go without it.
import "~/styles.css";

export function Landing({ locale }: { readonly locale: Locale }): ReactNode {
  const copy = copies[locale];
  const other = locale === "ar" ? "en" : "ar";
  const docs = docsPath[locale];
  const sections: Readonly<Record<Section, ReactNode>> = {
    admin: <Admin copy={copy} />,
    alerts: <Alerts copy={copy} />,
    arabic: <ArabicFirst copy={copy} />,
    checks: <Checks copy={copy} />,
    install: <Install copy={copy} locale={locale} />,
    pages: <Pages copy={copy} />,
    server: <Server copy={copy} />,
  };
  const link =
    "whitespace-nowrap px-2.5 py-1 text-[13px] text-muted transition-colors hover:text-fg";
  return (
    <>
      <header className="sticky top-4 z-20 flex justify-center px-4">
        <nav className="pill flex h-12 items-center gap-1 rounded-full ps-2 pe-2">
          <a
            className="flex items-center gap-2 ps-1.5 pe-2 font-medium text-[15px]"
            href={homePath[locale]}
          >
            <span className="grid size-6 place-items-center rounded-md bg-action text-action-fg [&>svg]:size-3.5">
              <ActivityIcon />
            </span>
            {copy.brand}
          </a>
          <span className="mx-1 h-5 w-px bg-line max-md:hidden" />
          <a className={`${link} max-md:hidden`} href="#checks">
            {copy.nav.checks}
          </a>
          <a className={`${link} max-md:hidden`} href="#alerts">
            {copy.nav.alerts}
          </a>
          <a className={`${link} max-md:hidden`} href="#pages">
            {copy.nav.pages}
          </a>
          <a className={`${link} max-md:hidden`} href={docs}>
            {copy.nav.docs}
          </a>
          <span className="mx-1 h-5 w-px bg-line max-md:hidden" />
          <a
            className={`${link} inline-flex items-center gap-1.5`}
            href={homePath[other]}
            lang={other}
          >
            <LanguagesIcon className="size-3.5" />
            <span className="max-md:sr-only">{copy.other}</span>
          </a>
          <ThemeSwitch copy={copy.theme} />
          <a
            aria-label="GitHub"
            className="ms-1 inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted transition-colors hover:text-fg"
            href={repository}
          >
            <Logo brand="github" className="size-4" />
          </a>
        </nav>
      </header>
      <main>
        <Hero copy={copy} locale={locale} />
        {copy.order.map((name) => (
          <div key={name}>{sections[name]}</div>
        ))}
      </main>
      <footer className="mx-auto mt-32 max-w-[1200px] border-line border-t px-6 py-8 text-[13px] text-muted">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="flex items-center gap-2 font-medium text-fg">
            <span className="grid size-5 place-items-center rounded-md bg-action text-action-fg [&>svg]:size-3">
              <ActivityIcon />
            </span>
            {copy.brand}
          </span>
          <a className="hover:text-fg" href={docs}>
            {copy.nav.docs}
          </a>
          <a className="hover:text-fg" href={`${docs}/api`}>
            {copy.footer.api}
          </a>
          <a className="token hover:text-fg" href="/llms.txt">
            llms.txt
          </a>
          <a className="hover:text-fg" href={repository}>
            GitHub
          </a>
          <a className="hover:text-fg" href={homePath[other]} lang={other}>
            {copy.other}
          </a>
        </div>
        <p className="mt-3 max-w-[60em] text-[12px] text-faint">
          {copy.footer.licence}
        </p>
      </footer>
    </>
  );
}
