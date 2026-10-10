/**
 * The docs' own Markdown pieces, in place of Fumadocs' defaults where
 * those read as basic: a code block with its language and the copy button in
 * a bar above the code, so the button never covers it, drawn with the
 * site's copy icon, and a note as a
 * coloured mark and a line on its start side instead of a tinted box.
 */
import { CodeBlock, Pre } from "@fumadocs/base-ui/components/codeblock";
import { useI18n } from "@fumadocs/base-ui/contexts/i18n";
import defaultMdxComponents from "@fumadocs/base-ui/mdx";
import {
  type ComponentProps,
  isValidElement,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { CheckIcon, CopyIcon, TriangleAlertIcon } from "@/shared/ui/icons.tsx";
import { copies } from "~/copy.ts";

/** The language the highlighter named on the code element, or nothing for plain text. */
function languageOf(children: ReactNode): string | undefined {
  if (!isValidElement<{ className?: string }>(children)) {
    return;
  }
  const language = children.props.className?.match(languageClass)?.[1];
  return language === "text" ? undefined : language;
}

const languageClass = /language-(\S+)/;

/** The code block's copy button: the copy icon, then a check for a moment once the code is on the clipboard. */
function CopyCode(): ReactNode {
  const { locale } = useI18n();
  const words = copies[locale === "en" ? "en" : "ar"].copyCode;
  const [copied, setCopied] = useState(false);
  const copy = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const code = event.currentTarget.closest("figure")?.querySelector("pre");
    navigator.clipboard
      .writeText(code?.textContent ?? "")
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopied(false));
  }, []);
  return (
    <button
      aria-label={copied ? words.copied : words.copy}
      aria-live="polite"
      className="grid size-7 cursor-pointer place-items-center rounded-md text-muted transition-colors hover:bg-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      data-copied={copied || undefined}
      onClick={copy}
      title={copied ? words.copied : words.copy}
      type="button"
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-teal" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}

function CodePre({ children, ...props }: ComponentProps<"pre">): ReactNode {
  return (
    <CodeBlock {...props} Actions={CopyCode} title={languageOf(children) ?? ""}>
      <Pre>{children}</Pre>
    </CodeBlock>
  );
}

function InfoIcon({ className }: { readonly className?: string }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

function Callout({
  children,
  type = "info",
}: {
  readonly children?: ReactNode;
  readonly type?: "info" | "warn";
}): ReactNode {
  return (
    <aside className="docs-note" data-type={type} role="note">
      {type === "warn" ? (
        <TriangleAlertIcon className="docs-note-mark" />
      ) : (
        <InfoIcon className="docs-note-mark" />
      )}
      <div className="docs-note-body">{children}</div>
    </aside>
  );
}

export const mdxComponents = {
  ...defaultMdxComponents,
  Callout,
  pre: CodePre,
};
