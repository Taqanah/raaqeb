/**
 * The React side of the messages: one provider around the document and one
 * hook that answers the active locale and a typed translate function, so a
 * component never imports Lingui itself (ADR-0003).
 */
import type { I18n, MessageId } from "@lingui/core";
import { I18nProvider, useLingui } from "@lingui/react";
import type { ReactNode } from "react";
import { isLocale, type Locale } from "./locale.ts";

export interface MessagesProviderProps {
  readonly children: ReactNode;
  readonly i18n: I18n;
}

export function MessagesProvider({
  children,
  i18n,
}: MessagesProviderProps): ReactNode {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}

export interface MessagesContext {
  readonly locale: Locale;
  /** The message for an id, with its values interpolated. */
  readonly t: (id: MessageId, values?: Record<string, unknown>) => string;
}

export function useMessages(): MessagesContext {
  const { _, i18n } = useLingui();
  const { locale } = i18n;
  if (!isLocale(locale)) {
    throw new Error(`the active locale ${locale} is not one Raaqeb ships`);
  }
  return { locale, t: _ };
}
