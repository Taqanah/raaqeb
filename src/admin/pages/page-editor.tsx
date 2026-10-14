/**
 * The status page editor: one form of cards with one save,
 * as the monitor form is. The page: title, slug, page
 * language, the default switch and the custom domain. The components: the
 * ordered list with its groups (layout-card.tsx). The appearance: logo,
 * favicon and cover, which save on their own; the default theme, the brand
 * colour, the five status colours and the five status names. The content:
 * the description, the day bar and its length, percentages, the
 * subscription channels shown, the footer links, the contact link, noindex
 * and "powered by". Custom CSS last. No live preview: the public page is
 * rendered by its own route and a preview here would be a second renderer of it.
 */
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ContentField,
  ContentInputs,
  useContentIn,
} from "@/admin/shell/content.tsx";
import { formWidth, Page } from "@/admin/shell/page.tsx";
import { useRefusedFields } from "@/admin/shell/refused-fields.ts";
import { useSaveFlow } from "@/admin/shell/save-flow.ts";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import { formatUnit } from "@/shared/i18n/format.ts";
import { isLocale, locales } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { themes } from "@/shared/schemas/appearance.ts";
import { type ContentDraft, contentDraftOf } from "@/shared/schemas/content.ts";
import {
  barLengths,
  defaultStatusColours,
  footerLabelMaxLength,
  footerLinksMax,
  type PageDeleteResult,
  type PageEditor as PageEditorRead,
  type PageInput,
  type PageRefusal,
  type PageSaveResult,
  pageDescriptionMaxLength,
  pageImageKinds,
  pageTitleMaxLength,
  type StatusPage,
  type SubscriptionChannel,
  statusLabelMaxLength,
  subscriptionChannels,
} from "@/shared/schemas/page.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog.tsx";
import { Button, buttonVariants } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import { cn } from "@/shared/ui/cn.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import {
  ExternalLinkIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SunIcon,
  TrashIcon,
  XIcon,
} from "@/shared/ui/icons.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { localeNames } from "@/shared/ui/locale-switcher.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { StatusLevelBadge } from "@/shared/ui/status-level.tsx";
import { Switch } from "@/shared/ui/switch.tsx";
import { Textarea } from "@/shared/ui/textarea.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { type ImageActions, ImageField } from "./image-field.tsx";
import { LayoutCard } from "./layout-card.tsx";
import {
  type DraftItem,
  type FooterLinkDraft,
  type PageDraft,
  type PageFieldErrors,
  pageDraftOf,
  pageInputOf,
} from "./page-draft.ts";
import { pageRefusalWords } from "./page-words.ts";

/** The draft fields typed as text, each input named after its field. */
/** The levels from best to worst, then maintenance, so a page's colours and names read in order. */
const shownLevels: readonly StatusLevel[] = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
  "under_maintenance",
];

const textFields = ["contactUrl", "customCss", "customDomain", "slug"] as const;
type TextField = (typeof textFields)[number];

/** The draft fields a switch flips. */
type FlagField =
  | "bars"
  | "isDefault"
  | "noindex"
  | "percentages"
  | "poweredBy"
  | "published";

/** The public page's own ink, for links and buttons, until a brand colour is picked. */
const defaultBrand = "#171717";

/** Each choice's handler, taking the segmented control's value. */
type Choose = Readonly<
  Record<"barDays" | "locale" | "theme", (value: unknown) => void>
>;

const themeIcons = { dark: MoonIcon, light: SunIcon, system: MonitorIcon };

const themeWords = {
  dark: "setting_theme_dark",
  light: "setting_theme_light",
  system: "setting_theme_system",
} as const;

const subscriptionWords: Readonly<Record<SubscriptionChannel, MessageId>> = {
  email: "channel_type_email",
  webhook: "channel_type_webhook",
};

const formId = "page-editor";

/** The page's rules, as its save judges them. */
function judge(draft: PageDraft): PageFieldErrors {
  const parsed = pageInputOf(draft);
  return parsed.ok ? {} : parsed.errors;
}

export interface PageEditorProps {
  readonly editor: PageEditorRead;
  readonly images: ImageActions;
  /** Reads the page again, after an image changed. */
  readonly onImagesChanged: () => void;
  readonly onRemoved: () => void;
  readonly onSaved: (page: StatusPage) => void;
  /** Each answers nothing when the session check redirected and the page is leaving. */
  readonly remove: () => Promise<PageDeleteResult | undefined>;
  readonly save: (input: PageInput) => Promise<PageSaveResult | undefined>;
}

export function PageEditor({
  editor,
  images,
  onImagesChanged,
  onRemoved,
  onSaved,
  remove,
  save,
}: PageEditorProps): ReactNode {
  const { t } = useMessages();
  const text = useContentIn();
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(() => pageDraftOf(editor));
  const { clear, errors, refuse } = useRefusedFields(form, draft, judge);
  const saving = useSaveFlow<PageDraft, PageRefusal>(draft);
  const { report } = saving;

  const onText = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { name, value } = event.currentTarget;
      const field = textFields.find((each): each is TextField => each === name);
      if (field) {
        setDraft((current) => ({ ...current, [field]: value }));
      }
    },
    []
  );
  const onFlag = useCallback((field: FlagField, on: boolean) => {
    setDraft((current) => ({ ...current, [field]: on }));
  }, []);
  // One handler per short choice, each a segmented control; a value outside its list changes nothing.
  const onChoose = useMemo<Choose>(
    () => ({
      barDays: (value) => {
        const days = barLengths.find((each) => String(each) === String(value));
        if (days) {
          setDraft((current) => ({ ...current, barDays: days }));
        }
      },
      locale: (value) => {
        if (isLocale(value)) {
          setDraft((current) => ({ ...current, locale: value }));
        }
      },
      theme: (value) => {
        const theme = themes.find((each) => each === value);
        if (theme) {
          setDraft((current) => ({ ...current, theme }));
        }
      },
    }),
    []
  );
  const onLayout = useCallback((layout: DraftItem[]) => {
    setDraft((current) => ({ ...current, layout }));
  }, []);
  const onPart: PartChange = useCallback((part) => {
    setDraft((current) => ({ ...current, ...part }));
  }, []);

  const onSubmit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = pageInputOf(draft);
      if (!parsed.ok) {
        refuse(parsed.errors);
        report({ draft, kind: "failed", reason: "invalid" });
        return;
      }
      clear();
      if (!report({ draft, kind: "pending" })) {
        return;
      }
      const result = await save(parsed.input).catch(() => undefined);
      if (!result?.ok) {
        const reason = result?.ok === false ? result.reason : "unavailable";
        if (reason === "slug_taken") {
          refuse({ slug: pageRefusalWords.slug_taken });
        } else if (
          reason === "domain_taken" ||
          reason === "domain_public_address"
        ) {
          refuse({ customDomain: pageRefusalWords[reason] });
        }
        report({ draft, kind: "failed", reason });
        return;
      }
      report({ draft, kind: "saved" });
      onSaved(result.page);
    },
    [clear, draft, onSaved, refuse, report, save]
  );

  const { page } = editor;
  const action = (
    <>
      {/* The live page, which a signed-in operator sees even unpublished; every page answers at /status/<slug>. */}
      <a
        className={buttonVariants({ variant: "outline" })}
        data-slot="page-view-link"
        href={`/status/${page.slug}`}
        rel="noopener"
        target="_blank"
      >
        <ExternalLinkIcon />
        {t("page_view")}
      </a>
      <Link
        className={buttonVariants({ variant: "outline" })}
        data-slot="page-subscribers-link"
        params={{ id: page.id }}
        to="/admin/pages/$id/subscribers"
      >
        {t("page_subscribers")}
      </Link>
    </>
  );
  return (
    <Page
      action={action}
      parent={{ label: t("page_list_title"), to: "/admin/pages" }}
      title={text(page.title)}
    >
      <form
        className={cn("flex flex-col gap-6", formWidth)}
        data-slot="page-editor"
        id={formId}
        method="post"
        noValidate
        onSubmit={onSubmit}
        ref={form}
      >
        <PageCard
          draft={draft}
          errors={errors}
          onChoose={onChoose}
          onFlag={onFlag}
          onPart={onPart}
          onText={onText}
        />
        <LayoutCard
          components={editor.components}
          errors={errors}
          layout={draft.layout}
          locale={draft.locale}
          onLayout={onLayout}
        />
        <Card data-section="page-appearance">
          <CardHeader divided>
            <CardTitle>{t("page_section_appearance")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {pageImageKinds.map((kind) => (
              <ImageField
                actions={images}
                image={editor.images.find((each) => each.kind === kind)}
                key={kind}
                kind={kind}
                onChanged={onImagesChanged}
                pageId={page.id}
              />
            ))}
            <Field>
              <FieldLabel id="theme-label">{t("page_field_theme")}</FieldLabel>
              <Segmented
                aria-labelledby="theme-label"
                data-name="theme"
                name="theme"
                onValueChange={onChoose.theme}
                value={draft.theme}
              >
                {themes.map((each) => {
                  const Icon = themeIcons[each];
                  return (
                    <SegmentedItem key={each} value={each}>
                      <Icon />
                      {t(themeWords[each])}
                    </SegmentedItem>
                  );
                })}
              </Segmented>
              <FieldDescription>{t("page_field_theme_hint")}</FieldDescription>
            </Field>
            <BrandColour draft={draft} onPart={onPart} />
            <StatusColours draft={draft} onPart={onPart} />
            <StatusNames
              draft={draft}
              errors={errors}
              names={editor.statusNames}
              onPart={onPart}
            />
          </CardContent>
        </Card>
        <ContentCard
          draft={draft}
          errors={errors}
          onChoose={onChoose}
          onFlag={onFlag}
          onPart={onPart}
          onText={onText}
        />
        <Card data-section="page-css">
          <CardHeader divided>
            <CardTitle>{t("page_section_css")}</CardTitle>
            <CardDescription>{t("page_field_css_hint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Field>
              <Textarea
                aria-invalid={
                  errors["customization.customCss"] ? true : undefined
                }
                aria-label={t("page_section_css")}
                className="font-mono"
                dir="ltr"
                name="customCss"
                onChange={onText}
                rows={8}
                spellCheck={false}
                value={draft.customCss}
              />
              <Refusal errors={errors} path="customization.customCss" />
            </Field>
          </CardContent>
          <SaveFooter
            pendingLabel={t("page_saving")}
            refusals={pageRefusalWords}
            saved="page_saved"
            slot="save-page"
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
      <DeletePage onRemoved={onRemoved} remove={remove} />
    </Page>
  );
}

/** The refusal of one field by its path; nothing when it is fine. */
function Refusal({
  errors,
  path,
}: {
  readonly errors: PageFieldErrors;
  readonly path: string;
}): ReactNode {
  const { t } = useMessages();
  const error = errors[path];
  return error ? (
    <FieldError data-error-for={path}>{t(error)}</FieldError>
  ) : null;
}

/** One switch with its label and hint, flipping one draft field. */
function FlagRow({
  checked,
  field,
  hint,
  label,
  onFlag,
}: {
  readonly checked: boolean;
  readonly field: FlagField;
  readonly hint?: string;
  readonly label: string;
  readonly onFlag: (field: FlagField, on: boolean) => void;
}): ReactNode {
  const flip = useCallback((on: boolean) => onFlag(field, on), [field, onFlag]);
  return (
    <Field orientation="horizontal">
      <Switch
        checked={checked}
        id={field}
        name={field}
        onCheckedChange={flip}
      />
      <div className="flex flex-col gap-0.5">
        <FieldLabel htmlFor={field}>{label}</FieldLabel>
        {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      </div>
    </Field>
  );
}

function PageCard({
  draft,
  errors,
  onFlag,
  onChoose,
  onPart,
  onText,
}: {
  readonly draft: PageDraft;
  readonly errors: PageFieldErrors;
  readonly onFlag: (field: FlagField, on: boolean) => void;
  readonly onChoose: Choose;
  readonly onPart: PartChange;
  readonly onText: (event: ChangeEvent<HTMLInputElement>) => void;
}): ReactNode {
  const { t } = useMessages();
  const slug = draft.slug.trim().toLowerCase();
  const onTitle = useCallback(
    (title: ContentDraft) => onPart({ title }),
    [onPart]
  );
  return (
    <Card data-section="page-page">
      <CardHeader divided>
        <CardTitle>{t("page_section_page")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ContentField
          description={t("page_field_title_hint")}
          error={errors.title && t(errors.title)}
          id="title"
          label={t("page_field_title")}
          max={pageTitleMaxLength}
          onChange={onTitle}
          required={draft.locale}
          value={draft.title}
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="slug">{t("page_field_slug")}</FieldLabel>
            <Input
              aria-invalid={errors.slug ? true : undefined}
              autoComplete="off"
              id="slug"
              name="slug"
              onChange={onText}
              value={draft.slug}
              variant="token"
            />
            {slug === "" ? null : (
              <FieldDescription>
                {t("page_served_at")} <Token>{`/status/${slug}`}</Token>
              </FieldDescription>
            )}
            <Refusal errors={errors} path="slug" />
          </Field>
          <Field>
            <FieldLabel id="locale-label">{t("page_field_locale")}</FieldLabel>
            <Segmented
              aria-labelledby="locale-label"
              data-name="locale"
              name="locale"
              onValueChange={onChoose.locale}
              value={draft.locale}
            >
              {locales.map((each) => (
                <SegmentedItem key={each} lang={each} value={each}>
                  {localeNames[each]}
                </SegmentedItem>
              ))}
            </Segmented>
          </Field>
        </div>
        <FieldDescription>{t("page_field_locale_hint")}</FieldDescription>
        <FlagRow
          checked={draft.published}
          field="published"
          hint={t("page_field_published_hint")}
          label={t("page_field_published")}
          onFlag={onFlag}
        />
        <FlagRow
          checked={draft.isDefault}
          field="isDefault"
          hint={t("page_field_default_hint")}
          label={t("page_field_default")}
          onFlag={onFlag}
        />
        <Field>
          <FieldLabel htmlFor="customDomain">
            {t("page_field_domain")}
          </FieldLabel>
          <Input
            aria-invalid={errors.customDomain ? true : undefined}
            autoComplete="off"
            id="customDomain"
            name="customDomain"
            onChange={onText}
            placeholder="status.raaqeb.dev"
            value={draft.customDomain}
            variant="token"
          />
          <FieldDescription>{t("page_field_domain_hint")}</FieldDescription>
          <Refusal errors={errors} path="customDomain" />
        </Field>
      </CardContent>
    </Card>
  );
}

type PartChange = (
  part: Partial<
    Pick<
      PageDraft,
      | "brandColour"
      | "description"
      | "footerLinks"
      | "labels"
      | "statusColours"
      | "subscriptions"
      | "title"
    >
  >
) => void;

/** A colour picked with the platform's picker, or the default until one is. */
function ColourField({
  fallback,
  hint,
  label,
  name,
  onColour,
  value,
}: {
  readonly fallback: string;
  readonly hint?: string;
  readonly label: ReactNode;
  readonly name: string;
  readonly onColour: (value: string) => void;
  readonly value: string;
}): ReactNode {
  const { t } = useMessages();
  const pick = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onColour(event.currentTarget.value),
    [onColour]
  );
  const reset = useCallback(() => onColour(""), [onColour]);
  return (
    <Field data-colour={name}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <div className="flex items-center gap-3">
        <input
          className="h-control w-14 cursor-pointer rounded-lg border border-input bg-background p-1"
          id={name}
          name={name}
          onChange={pick}
          type="color"
          value={value === "" ? fallback : value}
        />
        {value === "" ? (
          <span className="text-muted-foreground text-sm">
            {t("page_colour_default")}
          </span>
        ) : (
          <>
            <Token>{value}</Token>
            <Button onClick={reset} type="button" variant="ghost">
              {t("page_colour_reset")}
            </Button>
          </>
        )}
      </div>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/** The brand colour and each level's colour write into the draft through one change. */
function useColour(
  onPart: PartChange,
  draft: PageDraft,
  level: StatusLevel | undefined
): (value: string) => void {
  return useCallback(
    (value: string) =>
      onPart(
        level === undefined
          ? { brandColour: value }
          : { statusColours: { ...draft.statusColours, [level]: value } }
      ),
    [draft.statusColours, level, onPart]
  );
}

function BrandColour({
  draft,
  onPart,
}: {
  readonly draft: PageDraft;
  readonly onPart: PartChange;
}): ReactNode {
  const { t } = useMessages();
  const onColour = useColour(onPart, draft, undefined);
  return (
    <ColourField
      fallback={defaultBrand}
      hint={t("page_field_brand_hint")}
      label={t("page_field_brand")}
      name="brandColour"
      onColour={onColour}
      value={draft.brandColour}
    />
  );
}

function StatusColours({
  draft,
  onPart,
}: {
  readonly draft: PageDraft;
  readonly onPart: PartChange;
}): ReactNode {
  const { t } = useMessages();
  return (
    <div className="flex flex-col gap-3" data-slot="status-colours">
      <span className="font-medium text-sm">
        {t("page_field_status_colours")}
      </span>
      <div className="grid gap-4 sm:grid-cols-2">
        {shownLevels.map((level) => (
          <LevelColour
            draft={draft}
            key={level}
            level={level}
            onPart={onPart}
          />
        ))}
      </div>
    </div>
  );
}

function LevelColour({
  draft,
  level,
  onPart,
}: {
  readonly draft: PageDraft;
  readonly level: StatusLevel;
  readonly onPart: PartChange;
}): ReactNode {
  const onColour = useColour(onPart, draft, level);
  return (
    <ColourField
      fallback={defaultStatusColours[level]}
      label={<StatusLevelBadge level={level} />}
      name={`colour-${level}`}
      onColour={onColour}
      value={draft.statusColours[level]}
    />
  );
}

function StatusNames({
  draft,
  errors,
  names,
  onPart,
}: {
  readonly draft: PageDraft;
  readonly errors: PageFieldErrors;
  readonly names: PageEditorRead["statusNames"];
  readonly onPart: PartChange;
}): ReactNode {
  const { t } = useMessages();
  return (
    <div className="flex flex-col gap-3" data-slot="status-names">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-sm">{t("page_field_labels")}</span>
        <span className="text-muted-foreground text-xs">
          {t("page_field_labels_hint")}
        </span>
        <span className="text-muted-foreground text-xs">
          {t("page_field_labels_language_hint")}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {shownLevels.map((level) => (
          <StatusName
            draft={draft}
            errors={errors}
            key={level}
            level={level}
            onPart={onPart}
            statusNames={names}
          />
        ))}
      </div>
    </div>
  );
}

function StatusName({
  draft,
  errors,
  level,
  onPart,
  statusNames,
}: {
  readonly draft: PageDraft;
  readonly errors: PageFieldErrors;
  readonly level: StatusLevel;
  readonly onPart: PartChange;
  /** Each level's own name in every locale, shown in an empty input. */
  readonly statusNames: PageEditorRead["statusNames"];
}): ReactNode {
  const { t } = useMessages();
  const path = `customization.labels.${level}`;
  const onName = useCallback(
    (name: ContentDraft) =>
      onPart({ labels: { ...draft.labels, [level]: name } }),
    [draft.labels, level, onPart]
  );
  const error = errors[path];
  return (
    <ContentField
      error={error && t(error)}
      id={`label-${level}`}
      independent
      label={<StatusLevelBadge level={level} />}
      max={statusLabelMaxLength}
      onChange={onName}
      optional
      placeholders={{
        ar: statusNames.ar[level],
        en: statusNames.en[level],
      }}
      required={draft.locale}
      value={draft.labels[level]}
    />
  );
}

function ContentCard({
  draft,
  errors,
  onFlag,
  onPart,
  onChoose,
  onText,
}: {
  readonly draft: PageDraft;
  readonly errors: PageFieldErrors;
  readonly onFlag: (field: FlagField, on: boolean) => void;
  readonly onPart: PartChange;
  readonly onChoose: Choose;
  readonly onText: (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => void;
}): ReactNode {
  const { locale, t } = useMessages();
  const onDescription = useCallback(
    (description: ContentDraft) => onPart({ description }),
    [onPart]
  );
  return (
    <Card data-section="page-content">
      <CardHeader divided>
        <CardTitle>{t("page_section_content")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ContentField
          description={t("page_field_description_hint")}
          error={
            errors["customization.description"] &&
            t(errors["customization.description"])
          }
          id="description"
          label={t("page_field_description")}
          max={pageDescriptionMaxLength}
          multiline={2}
          onChange={onDescription}
          optional
          required={draft.locale}
          value={draft.description}
        />
        <FlagRow
          checked={draft.bars}
          field="bars"
          hint={t("page_field_bars_hint")}
          label={t("page_field_bars")}
          onFlag={onFlag}
        />
        {draft.bars ? (
          <Field>
            <FieldLabel id="barDays-label">
              {t("page_field_bar_days")}
            </FieldLabel>
            <Segmented
              aria-labelledby="barDays-label"
              data-name="barDays"
              name="barDays"
              onValueChange={onChoose.barDays}
              value={String(draft.barDays)}
            >
              {barLengths.map((days) => (
                <SegmentedItem key={days} value={String(days)}>
                  {formatUnit(locale, days, "day", "long")}
                </SegmentedItem>
              ))}
            </Segmented>
          </Field>
        ) : null}
        <FlagRow
          checked={draft.percentages}
          field="percentages"
          label={t("page_field_percentages")}
          onFlag={onFlag}
        />
        <Subscriptions draft={draft} onPart={onPart} />
        <FooterLinks draft={draft} errors={errors} onPart={onPart} />
        <Field>
          <FieldLabel htmlFor="contactUrl">
            {t("page_field_contact")}
          </FieldLabel>
          <Input
            aria-invalid={errors["customization.contactUrl"] ? true : undefined}
            autoComplete="off"
            id="contactUrl"
            name="contactUrl"
            onChange={onText}
            placeholder="mailto:support@raaqeb.dev"
            value={draft.contactUrl}
            variant="token"
          />
          <FieldDescription>{t("page_field_contact_hint")}</FieldDescription>
          <Refusal errors={errors} path="customization.contactUrl" />
        </Field>
        <FlagRow
          checked={draft.noindex}
          field="noindex"
          label={t("page_field_noindex")}
          onFlag={onFlag}
        />
        <FlagRow
          checked={draft.poweredBy}
          field="poweredBy"
          label={t("page_field_powered_by")}
          onFlag={onFlag}
        />
      </CardContent>
    </Card>
  );
}

function Subscriptions({
  draft,
  onPart,
}: {
  readonly draft: PageDraft;
  readonly onPart: PartChange;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Field data-slot="page-subscriptions">
      <span className="font-medium text-sm">
        {t("page_field_subscriptions")}
      </span>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        {subscriptionChannels.map((channel) => (
          <SubscriptionChoice
            channel={channel}
            draft={draft}
            key={channel}
            label={t(subscriptionWords[channel])}
            onPart={onPart}
          />
        ))}
      </div>
      <FieldDescription>{t("page_field_subscriptions_hint")}</FieldDescription>
    </Field>
  );
}

function SubscriptionChoice({
  channel,
  draft,
  label,
  onPart,
}: {
  readonly channel: SubscriptionChannel;
  readonly draft: PageDraft;
  readonly label: string;
  readonly onPart: PartChange;
}): ReactNode {
  const toggle = useCallback(
    (on: boolean) =>
      onPart({
        // Kept in the declared order, whichever is ticked first.
        subscriptions: subscriptionChannels.filter((each) =>
          each === channel ? on : draft.subscriptions.includes(each)
        ),
      }),
    [channel, draft.subscriptions, onPart]
  );
  return (
    <Field className="w-auto" orientation="horizontal">
      <Checkbox
        checked={draft.subscriptions.includes(channel)}
        data-channel={channel}
        id={`subscribe-${channel}`}
        onCheckedChange={toggle}
      />
      <FieldLabel htmlFor={`subscribe-${channel}`}>{label}</FieldLabel>
    </Field>
  );
}

function FooterLinks({
  draft,
  errors,
  onPart,
}: {
  readonly draft: PageDraft;
  readonly errors: PageFieldErrors;
  readonly onPart: PartChange;
}): ReactNode {
  const { t } = useMessages();
  const add = useCallback(() => {
    const keys = new Set(draft.footerLinks.map((link) => link.key));
    let number = keys.size + 1;
    while (keys.has(`link-${number}`)) {
      number += 1;
    }
    onPart({
      footerLinks: [
        ...draft.footerLinks,
        { key: `link-${number}`, label: contentDraftOf(undefined), url: "" },
      ],
    });
  }, [draft.footerLinks, onPart]);
  return (
    <div className="flex flex-col gap-3" data-slot="footer-links">
      <span className="font-medium text-sm">{t("page_field_footer")}</span>
      {draft.footerLinks.map((link, row) => (
        <FooterRow
          draft={draft}
          errors={errors}
          key={link.key}
          link={link}
          onPart={onPart}
          row={row}
        />
      ))}
      <Button
        className="self-start"
        data-slot="add-footer-link"
        disabled={draft.footerLinks.length >= footerLinksMax}
        onClick={add}
        type="button"
        variant="outline"
      >
        <PlusIcon />
        {t("page_footer_add")}
      </Button>
    </div>
  );
}

function FooterRow({
  draft,
  errors,
  link,
  onPart,
  row,
}: {
  readonly draft: PageDraft;
  readonly errors: PageFieldErrors;
  readonly link: FooterLinkDraft;
  readonly onPart: PartChange;
  readonly row: number;
}): ReactNode {
  const { t } = useMessages();
  const changed = useCallback(
    (part: Partial<FooterLinkDraft>) =>
      onPart({
        footerLinks: draft.footerLinks.map((each) =>
          each.key === link.key ? { ...each, ...part } : each
        ),
      }),
    [draft.footerLinks, link.key, onPart]
  );
  const onLabel = useCallback(
    (label: ContentDraft) => changed({ label }),
    [changed]
  );
  const onUrl = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      changed({ url: event.currentTarget.value }),
    [changed]
  );
  const remove = useCallback(
    () =>
      onPart({
        footerLinks: draft.footerLinks.filter((each) => each.key !== link.key),
      }),
    [draft.footerLinks, link.key, onPart]
  );
  const path = `customization.footerLinks.${row}`;
  return (
    <div className="flex flex-col gap-1" data-slot="footer-link">
      <div className="flex flex-wrap items-start gap-2">
        {/* On a phone the label takes the row and the link sits under it, so neither shrinks to a sliver. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-sm:basis-full">
          <ContentInputs
            id={`footer-${row}-label`}
            invalid={errors[`${path}.label`] !== undefined}
            label={t("page_footer_label")}
            max={footerLabelMaxLength}
            onChange={onLabel}
            required={draft.locale}
            value={link.label}
          />
          <Refusal errors={errors} path={`${path}.label`} />
        </div>
        <div className="flex min-w-0 flex-[2] flex-col gap-1">
          <Input
            aria-invalid={errors[`${path}.url`] ? true : undefined}
            aria-label={t("page_footer_url")}
            name={`footer-${row}-url`}
            onChange={onUrl}
            placeholder="https://"
            value={link.url}
            variant="token"
          />
          <Refusal errors={errors} path={`${path}.url`} />
        </div>
        <Button
          aria-label={t("page_footer_remove")}
          onClick={remove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
}

/** Delete, after the operator confirms. */
function DeletePage({
  onRemoved,
  remove,
}: {
  readonly onRemoved: () => void;
  readonly remove: () => Promise<PageDeleteResult | undefined>;
}): ReactNode {
  const { t } = useMessages();
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState(false);
  const ask = useCallback(() => setOpen(true), []);
  const confirm = useCallback(async () => {
    const result = await remove().catch(() => undefined);
    if (result?.ok) {
      onRemoved();
      return;
    }
    setRefused(true);
  }, [onRemoved, remove]);
  return (
    <div className="flex flex-col gap-2">
      <Button
        className="self-start"
        data-slot="delete-page"
        onClick={ask}
        type="button"
        variant="destructive-outline"
      >
        <TrashIcon />
        {t("page_delete")}
      </Button>
      {refused ? (
        <p className="text-destructive text-sm" role="alert">
          {t("page_unavailable")}
        </p>
      ) : null}
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("page_delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("page_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("app_cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-slot="confirm-delete"
              onClick={confirm}
              variant="destructive"
            >
              {t("page_delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
