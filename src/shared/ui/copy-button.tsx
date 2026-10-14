import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Button, type ButtonProps } from "./button.tsx";
import { CheckIcon, CopyIcon } from "./icons.tsx";

export type CopyButtonProps = Omit<ButtonProps, "children" | "onClick"> & {
  /** The element showing the text, selected for the reader to copy where the clipboard is refused (a page over plain http has none). */
  readonly target: RefObject<HTMLElement | null>;
  readonly text: string;
};

/** Copies a machine token, then says so for two seconds. */
export function CopyButton({
  target,
  text,
  ...props
}: CopyButtonProps): ReactNode {
  const { t } = useMessages();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const later = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(later);
  }, [copied]);
  const select = useCallback(() => {
    if (target.current) {
      getSelection()?.selectAllChildren(target.current);
    }
  }, [target]);
  const copy = useCallback(() => {
    const written = navigator.clipboard?.writeText(text);
    if (!written) {
      select();
      return;
    }
    written.then(() => setCopied(true), select);
  }, [select, text]);
  return (
    <Button
      className="shrink-0"
      data-slot="copy"
      type="button"
      variant="outline"
      {...props}
      onClick={copy}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">{t(copied ? "app_copied" : "app_copy")}</span>
    </Button>
  );
}
