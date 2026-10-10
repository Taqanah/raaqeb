/**
 * The channel form's draft: what the operator has typed, the
 * input it posts, and one catalog message per refused field. The fields
 * come from the type's declaration, so a new channel type needs no change
 * here. A typed secret left empty keeps the stored one when there is one;
 * a generated field is never typed.
 */
import { normalizeDigits } from "@/shared/i18n/format.ts";
import { isLocale, type Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import {
  type ChannelField,
  type ChannelForm,
  type ChannelInput,
  type ChannelType,
  channelDeclarations,
  channelNameMaxLength,
  fieldsFor,
} from "@/shared/schemas/channel.ts";

export interface ChannelDraft {
  readonly appliesToNew: boolean;
  /** Empty follows the install language. */
  readonly locale: Locale | "";
  readonly name: string;
  /** Whether saving gives every generated field a new value. */
  readonly renewGenerated: boolean;
  readonly type: ChannelType;
  /** Each typed field's text, by field name. */
  readonly values: Readonly<Record<string, string>>;
}

/** The first refusal of each field: `name`, or a declared field's name. */
export type ChannelFieldErrors = Readonly<Partial<Record<string, MessageId>>>;

export type ChannelDraftParse =
  | { readonly ok: true; readonly input: ChannelInput }
  | { readonly ok: false; readonly errors: ChannelFieldErrors };

/** The fields the operator types, which is every declared field but the generated ones. */
function typedFields(type: ChannelType): readonly ChannelField[] {
  return channelDeclarations[type].fields.filter(
    (field) => field.kind !== "generated"
  );
}

/** A new channel's draft of the type, each field at its initial value, or the draft of the stored one: its typed values empty when secret, as stored otherwise. */
export function channelDraftOf(
  form: ChannelForm | undefined,
  type: ChannelType
): ChannelDraft {
  const channel = form?.channel;
  const values: Record<string, string> = {};
  for (const field of typedFields(channel?.type ?? type)) {
    // A field the stored channel has no value for starts where a new one would, so a channel stored before a field existed opens at its default.
    values[field.name] = field.secret
      ? ""
      : (channel?.config[field.name] ?? field.initial ?? "");
  }
  return {
    // The first channel an install adds usually serves every monitor.
    appliesToNew: channel?.appliesToNew ?? true,
    locale: channel?.locale ?? "",
    name: channel?.name ?? "",
    renewGenerated: false,
    type: channel?.type ?? type,
    values,
  };
}

/** What the form posts, or the refusal of every field that does not fit. Only the fields that apply to the typed values are posted; `kept` names the secrets an empty field keeps. */
export function channelInputOf(
  draft: ChannelDraft,
  kept: readonly string[]
): ChannelDraftParse {
  const errors: Record<string, MessageId> = {};
  const name = draft.name.trim();
  if (name === "" || name.length > channelNameMaxLength) {
    errors.name = "channel_refused_name";
  }
  const values: Record<string, string> = {};
  const applying = fieldsFor(channelDeclarations[draft.type], draft.values);
  for (const field of applying.filter((each) => each.kind !== "generated")) {
    const typed = (draft.values[field.name] ?? "").trim();
    if (typed === "") {
      if (!(field.optional || (field.secret && kept.includes(field.name)))) {
        errors[field.name] = "channel_refused_required";
      }
      continue;
    }
    if (!field.value.safeParse(typed).success) {
      errors[field.name] = field.refusal ?? refusalOf(field);
      continue;
    }
    values[field.name] = typed;
  }
  if (Object.keys(errors).length > 0) {
    return { errors, ok: false };
  }
  const input: ChannelInput = {
    appliesToNew: draft.appliesToNew,
    name,
    type: draft.type,
    values,
    ...(draft.locale === "" ? {} : { locale: draft.locale }),
  };
  return { input, ok: true };
}

/** A value that does not fit a field of this kind. */
function refusalOf(field: ChannelField): MessageId {
  return field.kind === "url" ? "channel_refused_url" : "channel_refused_text";
}

/** The draft with the field an input names set to what was typed: `name`, `locale`, or a declared field. A name the form does not have changes nothing. */
export function withChannelField(
  draft: ChannelDraft,
  name: string,
  value: string
): ChannelDraft {
  if (name === "name") {
    return { ...draft, name: value };
  }
  if (name === "locale") {
    return value === "" || isLocale(value)
      ? { ...draft, locale: value }
      : draft;
  }
  const field = typedFields(draft.type).find((each) => each.name === name);
  if (field) {
    // Western digits in every field but a secret, whose characters are the operator's own.
    const typed = field.secret ? value : normalizeDigits(value);
    return { ...draft, values: { ...draft.values, [name]: typed } };
  }
  return draft;
}
