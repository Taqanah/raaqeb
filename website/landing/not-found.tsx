/**
 * What an address that names no page shows, in the language of its
 * path: the brand, one line and the ways back. It sets its own title, keeps
 * search engines out and links the landing's stylesheet, since the root renders
 * it under any address and must not carry that stylesheet to every page.
 */
import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ActivityIcon } from "@/shared/ui/icons.tsx";
import { copies, docsPath } from "~/copy.ts";
import { homePath, pathLocale } from "~/locale.ts";
import styles from "~/styles.css?url";

export function NotFound(): ReactNode {
  const locale = useLocation({ select: (l) => pathLocale(l.pathname) });
  const copy = copies[locale];
  const words = copy.notFound;
  return (
    <main className="mx-auto flex min-h-dvh max-w-[1200px] flex-col justify-center px-6 py-24">
      <title>{`${words.head} | ${copy.brand}`}</title>
      <meta content="noindex" name="robots" />
      <link
        href={styles}
        // biome-ignore lint/suspicious/noUnknownAttribute: React 19 moves a stylesheet with a precedence into the head and waits for it
        precedence="default"
        rel="stylesheet"
      />
      <a
        className="flex w-fit items-center gap-2 font-medium text-[15px]"
        href={homePath[locale]}
      >
        <span className="grid size-6 place-items-center rounded-md bg-action text-action-fg [&>svg]:size-3.5">
          <ActivityIcon />
        </span>
        {copy.brand}
      </a>
      <h1 className="mt-16 max-w-[14em] text-balance font-medium text-[clamp(36px,4.6vw,56px)] leading-[1.1] tracking-[-0.03em] [&:lang(ar)]:leading-[1.35] [&:lang(ar)]:tracking-normal">
        {words.title}
      </h1>
      <p className="mt-6 max-w-[32em] text-pretty text-[19px] text-strong leading-[1.6]">
        {words.lead}
      </p>
      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
        <a
          className="inline-flex h-11 items-center whitespace-nowrap rounded-lg bg-action px-5 font-medium text-[15px] text-action-fg transition-transform hover:-translate-y-px active:translate-y-0"
          href={homePath[locale]}
        >
          {words.home}
        </a>
        <a
          className="whitespace-nowrap font-medium text-[15px] text-muted transition-colors hover:text-fg"
          href={docsPath[locale]}
        >
          {copy.nav.docs}{" "}
          <span aria-hidden="true">{locale === "ar" ? "←" : "→"}</span>
        </a>
      </div>
    </main>
  );
}
