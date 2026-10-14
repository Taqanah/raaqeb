/**
 * The new status page: its title, its slug and its page
 * language, prefilled from the install language. Everything else starts at
 * its default and is edited on the page's editor, where a create lands.
 */
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { formWidth, Page } from "@/admin/shell/page.tsx";
import { useRefusedFields } from "@/admin/shell/refused-fields.ts";
import { useSaveFlow } from "@/admin/shell/save-flow.ts";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import { isLocale, type Locale, locales } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  PageCreateInput,
  PageRefusal,
  PageSaveResult,
  StatusPage,
} from "@/shared/schemas/page.ts";
import { buttonVariants } from "@/shared/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { localeNames } from "@/shared/ui/locale-switcher.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { type NewPageDraft, newPageInputOf } from "./page-draft.ts";
import { pageRefusalWords } from "./page-words.ts";

/** The new page's rules, as its save judges them. */
function judge(
  draft: NewPageDraft
): Readonly<Partial<Record<"slug" | "title", MessageId>>> {
  const parsed = newPageInputOf(draft);
  return parsed.ok ? {} : parsed.errors;
}

export function NewPageForm({
  create,
  installLanguage,
  onCreated,
}: {
  readonly create: (
    input: PageCreateInput
  ) => Promise<PageSaveResult | undefined>;
  readonly installLanguage: Locale;
  readonly onCreated: (page: StatusPage) => void;
}): ReactNode {
  const { t } = useMessages();
  const [draft, setDraft] = useState<NewPageDraft>({
    locale: installLanguage,
    slug: "",
    title: "",
  });
  const formRef = useRef<HTMLFormElement>(null);
  const { clear, errors, refuse } = useRefusedFields(formRef, draft, judge);
  const saving = useSaveFlow<NewPageDraft, PageRefusal>(draft);
  const { report } = saving;

  const onField = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.currentTarget;
    setDraft((current) =>
      name === "slug"
        ? { ...current, slug: value }
        : { ...current, title: value }
    );
  }, []);
  const onLocale = useCallback((value: unknown) => {
    if (isLocale(value)) {
      setDraft((current) => ({ ...current, locale: value }));
    }
  }, []);

  const onSubmit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = newPageInputOf(draft);
      if (!parsed.ok) {
        refuse(parsed.errors);
        report({ draft, kind: "failed", reason: "invalid" });
        return;
      }
      clear();
      if (!report({ draft, kind: "pending" })) {
        return;
      }
      const result = await create(parsed.input).catch(() => undefined);
      if (!result?.ok) {
        const reason = result?.ok === false ? result.reason : "unavailable";
        if (reason === "slug_taken") {
          refuse({ slug: pageRefusalWords.slug_taken });
        }
        report({ draft, kind: "failed", reason });
        return;
      }
      report({ draft, kind: "saved" });
      onCreated(result.page);
    },
    [clear, create, draft, onCreated, refuse, report]
  );

  const slug = draft.slug.trim().toLowerCase();
  return (
    <Page
      parent={{ label: t("page_list_title"), to: "/admin/pages" }}
      title={t("page_new_title")}
    >
      <form
        className={formWidth}
        data-slot="new-page-form"
        method="post"
        noValidate
        onSubmit={onSubmit}
        ref={formRef}
      >
        <Card>
          <CardHeader divided>
            <CardTitle>{t("page_section_page")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field>
              <FieldLabel htmlFor="title">{t("page_field_title")}</FieldLabel>
              <Input
                aria-invalid={errors.title ? true : undefined}
                dir="auto"
                id="title"
                name="title"
                onChange={onField}
                value={draft.title}
              />
              <FieldDescription>{t("page_field_title_hint")}</FieldDescription>
              {errors.title ? <FieldError>{t(errors.title)}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="slug">{t("page_field_slug")}</FieldLabel>
              <Input
                aria-invalid={errors.slug ? true : undefined}
                autoComplete="off"
                id="slug"
                name="slug"
                onChange={onField}
                value={draft.slug}
                variant="token"
              />
              <FieldDescription>{t("page_field_slug_hint")}</FieldDescription>
              {slug === "" ? null : (
                <FieldDescription>
                  {t("page_served_at")} <Token>{`/status/${slug}`}</Token>
                </FieldDescription>
              )}
              {errors.slug ? <FieldError>{t(errors.slug)}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel id="locale-label">
                {t("page_field_locale")}
              </FieldLabel>
              <Segmented
                aria-labelledby="locale-label"
                data-name="locale"
                name="locale"
                onValueChange={onLocale}
                value={draft.locale}
              >
                {locales.map((each) => (
                  <SegmentedItem key={each} lang={each} value={each}>
                    {localeNames[each]}
                  </SegmentedItem>
                ))}
              </Segmented>
              <FieldDescription>{t("page_field_locale_hint")}</FieldDescription>
            </Field>
          </CardContent>
          <SaveFooter
            fresh
            label={t("page_create")}
            pendingLabel={t("page_creating")}
            refusals={pageRefusalWords}
            view={saving}
          >
            <Link
              className={buttonVariants({ variant: "outline" })}
              to="/admin/pages"
            >
              {t("app_cancel")}
            </Link>
          </SaveFooter>
        </Card>
      </form>
    </Page>
  );
}
