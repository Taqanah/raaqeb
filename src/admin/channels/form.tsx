/**
 * The channel page and the new-channel page: the name, the
 * type, the channel language (for a type whose messages are text), "apply
 * to new monitors by default", and the fields the type declares, rendered
 * from the declaration. A typed secret is write-only: the field stays
 * empty, and empty keeps the stored value. A generated one, the webhook's
 * signing secret, is shown as a token with a switch that renews it on save
 *. A stored channel's page adds its notification
 * preview, "send test", its recent sends and delete.
 */
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { formWidth, formWithPanel, Page } from "@/admin/shell/page.tsx";
import { useSaveFlow } from "@/admin/shell/save-flow.ts";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import type { TimeOptions } from "@/shared/i18n/format.ts";
import { locales } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type Channel,
  type ChannelDeleteResult,
  type ChannelField,
  type ChannelInput,
  type ChannelRefusal,
  type ChannelSaveResult,
  type ChannelTestResult,
  type ChannelType,
  channelDeclarations,
  channelTypes,
  fieldsFor,
  hintFor,
  type ChannelForm as StoredChannel,
} from "@/shared/schemas/channel.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
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
import { cn } from "@/shared/ui/cn.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import {
  BellIcon,
  HashIcon,
  MailIcon,
  MessageSquareIcon,
  SendIcon,
  TrashIcon,
  WebhookIcon,
} from "@/shared/ui/icons.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { localeNames } from "@/shared/ui/locale-switcher.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import {
  OptionCard,
  OptionCardBody,
  OptionCards,
} from "@/shared/ui/option-card.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { Switch } from "@/shared/ui/switch.tsx";
import { Token } from "@/shared/ui/token.tsx";
import {
  type ChannelDraft,
  type ChannelFieldErrors,
  channelDraftOf,
  channelInputOf,
  withChannelField,
} from "./draft.ts";
import { NotificationPreviewCard } from "./preview.tsx";
import { SendFailureText, SendRow, SendStatus } from "./send-parts.tsx";

const refusals: Readonly<Record<ChannelRefusal, MessageId>> = {
  invalid: "app_form_invalid",
  not_found: "channel_not_found",
  unavailable: "channel_unavailable",
};

const listPath = "/admin/channels";
const noErrors: ChannelFieldErrors = {};

/** Each channel type's icon on its card. */
const typeIcons: Readonly<Record<ChannelType, typeof BellIcon>> = {
  discord: MessageSquareIcon,
  email: MailIcon,
  ntfy: BellIcon,
  slack: HashIcon,
  telegram: SendIcon,
  webhook: WebhookIcon,
};
/** The email channel's address fields: a person's address keeps the page's face; every other declared value is a machine token. */
const emailAddresses = new Set(["from", "to"]);

export interface ChannelFormProps {
  /** The operator's time zone and clock, for the recent sends. */
  readonly clock: TimeOptions;
  /** The stored channel's read, or nothing for a new one. */
  readonly form: StoredChannel | undefined;
  /** Called once the channel is deleted. */
  readonly onRemoved?: () => void;
  /** Called with the saved channel. */
  readonly onSaved: (channel: Channel) => void;
  /** Answers nothing when the session check redirected and the page is leaving. */
  readonly remove?: () => Promise<ChannelDeleteResult | undefined>;
  readonly save: (
    input: ChannelInput,
    options: { readonly renewGenerated: boolean }
  ) => Promise<ChannelSaveResult | undefined>;
  readonly test?: () => Promise<ChannelTestResult | undefined>;
  /** A new channel's type. */
  readonly type: ChannelType;
}

export function ChannelForm({
  clock,
  form,
  onRemoved,
  onSaved,
  remove,
  save,
  test,
  type,
}: ChannelFormProps): ReactNode {
  const { t } = useMessages();
  const [draft, setDraft] = useState(() => channelDraftOf(form, type));
  const saving = useSaveFlow<ChannelDraft, ChannelRefusal>(draft);
  const { line, report } = saving;
  const kept = form?.kept ?? [];
  // Refusals show once the operator has tried to save, then follow every keystroke.
  const [marked, setMarked] = useState(false);
  const parsed = useMemo(
    () => channelInputOf(draft, form?.kept ?? []),
    [draft, form?.kept]
  );
  const errors = marked && !parsed.ok ? parsed.errors : noErrors;
  const declaration = channelDeclarations[draft.type];

  const onField = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const { name, value } = event.currentTarget;
      setDraft((current) => withChannelField(current, name, value));
    },
    []
  );
  const onLocale = useCallback((value: unknown) => {
    setDraft((current) => withChannelField(current, "locale", String(value)));
  }, []);
  const onType = useCallback((value: unknown) => {
    const chosen = channelTypes.find((each) => each === value);
    if (chosen) {
      setDraft((current) => ({
        ...channelDraftOf(undefined, chosen),
        name: current.name,
      }));
    }
  }, []);
  const onAppliesToNew = useCallback((on: boolean) => {
    setDraft((current) => ({ ...current, appliesToNew: on }));
  }, []);
  const onRenew = useCallback((on: boolean) => {
    setDraft((current) => ({ ...current, renewGenerated: on }));
  }, []);

  // After a refused save, the first marked field takes the focus; read after render, never in render scope.
  useEffect(() => {
    if (line.kind === "failed" && line.reason === "invalid") {
      document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
    }
  }, [line]);

  const onSubmit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      setMarked(true);
      if (!parsed.ok) {
        report({ draft, kind: "failed", reason: "invalid" });
        return;
      }
      report({ draft, kind: "pending" });
      const result = await save(parsed.input, {
        renewGenerated: draft.renewGenerated,
      }).catch(() => undefined);
      if (!result?.ok) {
        report({
          draft,
          kind: "failed",
          reason: result?.reason ?? "unavailable",
        });
        return;
      }
      // A saved secret is never shown again: its field empties, and empty keeps it.
      const next = {
        ...channelDraftOf(undefined, draft.type),
        appliesToNew: draft.appliesToNew,
        locale: draft.locale,
        name: draft.name,
      };
      setDraft(next);
      report({ draft: next, kind: "saved" });
      onSaved(result.channel);
    },
    [draft, onSaved, parsed, report, save]
  );

  const title = form ? form.channel.name : t("channel_new_title");
  return (
    <Page
      parent={{ label: t("channel_list_title"), to: "/admin/channels" }}
      title={title}
    >
      {/* Two columns only beside the test panel; a new channel has none, so its form is a single column. */}
      <div
        className={cn(
          "grid grid-cols-1 items-start gap-6",
          form && test ? formWithPanel : formWidth
        )}
      >
        <div className="flex flex-col gap-6">
          <form
            className="flex flex-col gap-6"
            data-slot="channel-form"
            method="post"
            noValidate
            onSubmit={onSubmit}
          >
            <Card>
              <CardHeader divided>
                <CardTitle>{t("channel_section_details")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <Field>
                  <FieldLabel htmlFor="name">
                    {t("channel_field_name")}
                  </FieldLabel>
                  <Input
                    aria-invalid={errors.name ? true : undefined}
                    dir="auto"
                    id="name"
                    name="name"
                    onChange={onField}
                    value={draft.name}
                  />
                  {errors.name ? (
                    <FieldError>{t(errors.name)}</FieldError>
                  ) : null}
                </Field>
                <TypeField form={form} onType={onType} type={draft.type} />
                {declaration.localized ? (
                  <Field>
                    <FieldLabel id="locale-label">
                      {t("channel_field_locale")}
                    </FieldLabel>
                    <Segmented
                      aria-labelledby="locale-label"
                      data-name="locale"
                      name="locale"
                      onValueChange={onLocale}
                      value={draft.locale}
                    >
                      <SegmentedItem value="">
                        {t("channel_locale_install")}
                      </SegmentedItem>
                      {locales.map((each) => (
                        <SegmentedItem key={each} lang={each} value={each}>
                          {localeNames[each]}
                        </SegmentedItem>
                      ))}
                    </Segmented>
                  </Field>
                ) : null}
                <Field orientation="horizontal">
                  <Switch
                    checked={draft.appliesToNew}
                    id="appliesToNew"
                    name="appliesToNew"
                    onCheckedChange={onAppliesToNew}
                  />
                  <div className="flex flex-col gap-0.5">
                    <FieldLabel htmlFor="appliesToNew">
                      {t("channel_field_applies_to_new")}
                    </FieldLabel>
                    <FieldDescription>
                      {t("channel_field_applies_to_new_hint")}
                    </FieldDescription>
                  </div>
                </Field>
                {fieldsFor(declaration, draft.values).map((field) =>
                  field.kind === "generated" ? (
                    <GeneratedField
                      draft={draft}
                      field={field}
                      form={form}
                      key={field.name}
                      onRenew={onRenew}
                    />
                  ) : (
                    <TypedField
                      draft={draft}
                      errors={errors}
                      field={field}
                      kept={kept.includes(field.name)}
                      key={field.name}
                      onField={onField}
                    />
                  )
                )}
                {form && form.summary === "" ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {t("channel_secrets_unreadable")}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </CardContent>
              <SaveFooter
                fresh={!form}
                pendingLabel={t("channel_saving")}
                refusals={refusals}
                saved="channel_saved"
                slot="save-channel"
                view={saving}
              >
                <Link
                  className={buttonVariants({ variant: "outline" })}
                  to={listPath}
                >
                  {t("app_cancel")}
                </Link>
              </SaveFooter>
            </Card>
          </form>
          {form ? (
            <NotificationPreviewCard
              machine={!channelDeclarations[form.channel.type].localized}
              preview={form.preview}
            />
          ) : null}
          {remove ? (
            <DeleteChannel onRemoved={onRemoved} remove={remove} />
          ) : null}
        </div>
        {form && test ? (
          <TestPanel clock={clock} form={form} test={test} />
        ) : null}
      </div>
    </Page>
  );
}

/** The type: a choice on a new channel, fixed on a stored one. */
function TypeField({
  form,
  onType,
  type,
}: {
  readonly form: StoredChannel | undefined;
  readonly onType: (value: unknown) => void;
  readonly type: ChannelType;
}): ReactNode {
  const { t } = useMessages();
  if (form) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>{t("channel_field_type")}</FieldLabel>
          <span className="text-sm">
            {t(channelDeclarations[form.channel.type].label)}
          </span>
        </Field>
        {form.summary === "" ? null : (
          <Field>
            <FieldLabel>{t("channel_column_destination")}</FieldLabel>
            {/* A vertical Field stretches its children; the wrapper takes that, so the token keeps its own width. */}
            <div>
              <Token data-slot="channel-summary">{form.summary}</Token>
            </div>
          </Field>
        )}
      </div>
    );
  }
  return (
    <Field>
      <FieldLabel id="type-label">{t("channel_field_type")}</FieldLabel>
      {/* A card per type with what it sends through, so the choice is made knowing it. */}
      <OptionCards
        aria-labelledby="type-label"
        className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        data-name="type"
        name="type"
        onValueChange={onType}
        value={type}
      >
        {channelTypes.map((each) => {
          const Icon = typeIcons[each];
          return (
            <OptionCard className="gap-3 pe-8" key={each} value={each}>
              <OptionCardBody
                description={t(`channel_type_${each}_lead`)}
                icon={<Icon />}
                title={t(channelDeclarations[each].label)}
              />
            </OptionCard>
          );
        })}
      </OptionCards>
    </Field>
  );
}

/** A field the operator types or chooses; a stored secret shows as kept and stays empty. */
function TypedField({
  draft,
  errors,
  field,
  kept,
  onField,
}: {
  readonly draft: ChannelDraft;
  readonly errors: ChannelFieldErrors;
  readonly field: ChannelField;
  readonly kept: boolean;
  readonly onField: (
    event: ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => void;
}): ReactNode {
  const { t } = useMessages();
  const error = errors[field.name];
  const value = draft.values[field.name] ?? "";
  const hidden = field.secret && field.kind === "text" && !field.shown;
  const hint = hintFor(field, value);
  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{t(field.label)}</FieldLabel>
      {field.kind === "select" ? (
        <NativeSelect
          id={field.name}
          name={field.name}
          onChange={onField}
          value={value}
        >
          {(field.options ?? []).map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {t(option.label)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <Input
          aria-invalid={error ? true : undefined}
          // A typed password or key is masked, and "new-password" keeps the browser from filling in the operator's own.
          autoComplete={hidden ? "new-password" : "off"}
          dir="ltr"
          id={field.name}
          name={field.name}
          onChange={onField}
          // A kept secret shows as dots, so the field reads as filled rather than empty.
          placeholder={kept ? "••••••••" : undefined}
          spellCheck={false}
          type={hidden ? "password" : field.kind}
          value={value}
          variant={emailAddresses.has(field.name) ? undefined : "token"}
        />
      )}
      {hint ? <FieldDescription>{t(hint)}</FieldDescription> : null}
      {kept ? (
        <FieldDescription>{t("channel_field_kept")}</FieldDescription>
      ) : null}
      {error ? <FieldError>{t(error)}</FieldError> : null}
    </Field>
  );
}

/** A value Raaqeb generates: shown on a stored channel so the receiver can be given it, with the switch that renews it. */
function GeneratedField({
  draft,
  field,
  form,
  onRenew,
}: {
  readonly draft: ChannelDraft;
  readonly field: ChannelField;
  readonly form: StoredChannel | undefined;
  readonly onRenew: (on: boolean) => void;
}): ReactNode {
  const { t } = useMessages();
  const value = form?.generated[field.name];
  return (
    <Field>
      <FieldLabel>{t(field.label)}</FieldLabel>
      {value === undefined ? (
        <FieldDescription>{t("channel_secret_after_save")}</FieldDescription>
      ) : (
        <Token
          className="block select-all break-all"
          data-slot="signing-secret"
        >
          {value}
        </Token>
      )}
      {field.hint ? <FieldDescription>{t(field.hint)}</FieldDescription> : null}
      {form ? (
        <Field orientation="horizontal">
          <Switch
            checked={draft.renewGenerated}
            id="renewGenerated"
            name="renewGenerated"
            onCheckedChange={onRenew}
          />
          <div className="flex flex-col gap-0.5">
            <FieldLabel htmlFor="renewGenerated">
              {t("channel_field_renew")}
            </FieldLabel>
            <FieldDescription>{t("channel_field_renew_hint")}</FieldDescription>
          </div>
        </Field>
      ) : null}
    </Field>
  );
}

type TestState =
  | { readonly kind: "idle" | "pending" }
  | { readonly kind: "done"; readonly result: ChannelTestResult | undefined };

/** "Send test" with its outcome, and the channel's recent sends under it. */
function TestPanel({
  clock,
  form,
  test,
}: {
  readonly clock: TimeOptions;
  readonly form: StoredChannel;
  readonly test: () => Promise<ChannelTestResult | undefined>;
}): ReactNode {
  const { t } = useMessages();
  const [state, setState] = useState<TestState>({ kind: "idle" });
  const run = useCallback(async () => {
    setState({ kind: "pending" });
    const result = await test().catch(() => undefined);
    setState({ kind: "done", result });
  }, [test]);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader divided>
          <CardTitle>{t("channel_section_test")}</CardTitle>
          <CardDescription>{t("channel_send_test_hint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button
            className="self-start"
            data-slot="send-test"
            disabled={state.kind === "pending"}
            onClick={run}
            type="button"
            variant="outline"
          >
            {state.kind === "pending"
              ? t("channel_sending")
              : t("channel_send_test")}
          </Button>
          {state.kind === "done" ? <TestResult result={state.result} /> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader divided>
          <CardTitle>{t("channel_recent_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {form.recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("channel_recent_empty")}
            </p>
          ) : (
            <ul data-slot="recent-sends">
              {form.recent.map((send) => (
                <SendRow clock={clock} key={send.id} send={send} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TestResult({
  result,
}: {
  readonly result: ChannelTestResult | undefined;
}): ReactNode {
  const { t } = useMessages();
  if (!result?.ok) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {t(refusals[result?.reason ?? "unavailable"])}
      </p>
    );
  }
  const { send } = result;
  return (
    <div
      className="flex flex-col gap-2"
      data-slot="test-result"
      data-status={send.status}
      role="status"
    >
      <SendStatus send={send} />
      {send.failure ? <SendFailureText failure={send.failure} /> : null}
    </div>
  );
}

/** Delete, after the operator confirms. */
function DeleteChannel({
  onRemoved,
  remove,
}: {
  readonly onRemoved: (() => void) | undefined;
  readonly remove: () => Promise<ChannelDeleteResult | undefined>;
}): ReactNode {
  const { t } = useMessages();
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState<ChannelRefusal | undefined>();
  const ask = useCallback(() => setOpen(true), []);
  const confirm = useCallback(async () => {
    const result = await remove().catch(() => undefined);
    if (result?.ok) {
      onRemoved?.();
      return;
    }
    setRefused(result?.ok === false ? result.reason : "unavailable");
  }, [onRemoved, remove]);
  return (
    <div className="flex flex-col gap-2">
      <Button
        className="self-start"
        data-slot="delete-channel"
        onClick={ask}
        type="button"
        variant="destructive-outline"
      >
        <TrashIcon />
        {t("channel_delete")}
      </Button>
      {refused ? (
        <p className="text-destructive text-sm" role="alert">
          {t(refusals[refused])}
        </p>
      ) : null}
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("channel_delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("channel_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("app_cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-slot="confirm-delete"
              onClick={confirm}
              variant="destructive"
            >
              {t("channel_delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
