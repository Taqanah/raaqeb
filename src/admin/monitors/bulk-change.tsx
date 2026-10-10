/**
 * The selection bar's changes: a menu of the five, each opening a
 * small dialog with its one field. A channel is chosen from the install's,
 * one to remove from those the selected monitors select; a group or a tag
 * to add is typed, with the names in use suggested, under the form's rules;
 * a tag to remove is one the selected monitors carry.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { ChannelChoice } from "@/shared/schemas/channel.ts";
import {
  type Monitor,
  type MonitorBulkResult,
  type MonitorChange,
  monitorChangeSchema,
  tagsMax,
} from "@/shared/schemas/monitor.ts";
import { Button } from "@/shared/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { ChevronDownIcon } from "@/shared/ui/icons.tsx";
import { Input } from "@/shared/ui/input.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import type { FieldError as Refusal } from "./draft.ts";

export type ChangeKind = MonitorChange["kind"];

const kindLabels: Readonly<Record<ChangeKind, MessageId>> = {
  add_channel: "monitor_bulk_add_channel",
  add_tag: "monitor_bulk_add_tag",
  remove_channel: "monitor_bulk_remove_channel",
  remove_tag: "monitor_bulk_remove_tag",
  set_group: "monitor_bulk_set_group",
};
const kinds: readonly ChangeKind[] = [
  "add_channel",
  "remove_channel",
  "set_group",
  "add_tag",
  "remove_tag",
];

/** The change the dialog's one field asks for, or the refusal that words why not; an empty group takes the monitors out of theirs. */
export function changeOf(
  kind: ChangeKind,
  value: string
): MonitorChange | Refusal {
  let posted: unknown;
  if (kind === "add_channel" || kind === "remove_channel") {
    posted = { channel: value, kind };
  } else if (kind === "set_group") {
    posted = { group: value.trim() === "" ? undefined : value, kind };
  } else {
    posted = { kind, tag: value };
  }
  const parsed = monitorChangeSchema.safeParse(posted);
  if (parsed.success) {
    return parsed.data;
  }
  const [issue] = parsed.error.issues;
  if (issue?.code === "too_big") {
    return {
      id: "monitor_error_too_long",
      values: { max: Number(issue.maximum) },
    };
  }
  if (issue?.code === "custom") {
    return { id: "monitor_bulk_tag_comma" };
  }
  return { id: "monitor_error_required" };
}

/** What a removal may offer: the channels and the tags at least one of the selected monitors has. */
export function removable(
  selected: readonly Pick<Monitor, "channels" | "tags">[],
  channels: readonly ChannelChoice[]
): { channels: ChannelChoice[]; tags: string[] } {
  const tags = new Set(selected.flatMap((monitor) => monitor.tags));
  return {
    channels: channels.filter((channel) =>
      selected.some((monitor) => monitor.channels.includes(channel.id))
    ),
    tags: [...tags].sort(),
  };
}

/** The refusal a server answer words in the dialog. */
const refusals: Readonly<
  Record<Extract<MonitorBulkResult, { ok: false }>["reason"], Refusal>
> = {
  invalid: { id: "monitor_error_invalid" },
  not_found: { id: "monitor_bulk_channel_gone" },
  tags_full: { id: "monitor_bulk_tags_full", values: { max: tagsMax } },
  unavailable: { id: "monitor_unavailable" },
};

export function BulkChange({
  channels,
  groups,
  onChange,
  selected,
  tags,
}: {
  readonly channels: readonly ChannelChoice[];
  /** The group and tag names in use, suggested as the operator types. */
  readonly groups: readonly string[];
  readonly onChange: (change: MonitorChange) => Promise<MonitorBulkResult>;
  readonly selected: readonly Monitor[];
  readonly tags: readonly string[];
}): ReactNode {
  const { t } = useMessages();
  const [kind, setKind] = useState<ChangeKind | undefined>();
  const [value, setValue] = useState("");
  const [refusal, setRefusal] = useState<Refusal | undefined>();
  const [pending, setPending] = useState(false);
  const removals = useMemo(
    () => removable(selected, channels),
    [channels, selected]
  );
  const choices = useMemo<Partial<Record<ChangeKind, readonly string[]>>>(
    () => ({
      add_channel: channels.map((channel) => channel.id),
      remove_channel: removals.channels.map((channel) => channel.id),
      remove_tag: removals.tags,
    }),
    [channels, removals]
  );

  const open = useCallback(
    (event: { readonly currentTarget: HTMLElement }) => {
      const next = kinds.find(
        (each) => each === event.currentTarget.dataset.change
      );
      if (next) {
        setKind(next);
        setValue(choices[next]?.[0] ?? "");
        setRefusal(undefined);
      }
    },
    [choices]
  );
  const close = useCallback((on: boolean) => {
    if (!on) {
      setKind(undefined);
    }
  }, []);
  const cancel = useCallback(() => setKind(undefined), []);
  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setValue(event.currentTarget.value),
    []
  );
  const apply = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (kind === undefined) {
        return;
      }
      const change = changeOf(kind, value);
      if ("id" in change) {
        setRefusal(change);
        return;
      }
      setPending(true);
      const result = await onChange(change).catch(
        () => ({ ok: false, reason: "unavailable" }) as const
      );
      setPending(false);
      if (result.ok) {
        setKind(undefined);
      } else {
        setRefusal(refusals[result.reason]);
      }
    },
    [kind, onChange, value]
  );

  const channelName = (id: string) =>
    channels.find((channel) => channel.id === id)?.name ?? id;
  let field: ReactNode = null;
  if (kind === "add_channel" || kind === "remove_channel") {
    field = (
      <NativeSelect
        className="w-full"
        id="bulk-value"
        name="channel"
        onChange={type}
        value={value}
      >
        {(choices[kind] ?? []).map((id) => (
          <NativeSelectOption key={id} value={id}>
            {channelName(id)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  } else if (kind === "remove_tag") {
    field = (
      <NativeSelect
        className="w-full"
        id="bulk-value"
        name="tag"
        onChange={type}
        value={value}
      >
        {removals.tags.map((tag) => (
          <NativeSelectOption key={tag} value={tag}>
            {tag}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  } else if (kind !== undefined) {
    field = (
      <Input
        aria-invalid={refusal ? true : undefined}
        dir="auto"
        id="bulk-value"
        list="bulk-names"
        name={kind === "set_group" ? "group" : "tag"}
        onChange={type}
        value={value}
      />
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button data-action="change" size="sm" variant="outline" />}
        >
          {t("monitor_bulk_change")}
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {kinds.map((each) => (
            <DropdownMenuItem
              data-change={each}
              disabled={choices[each]?.length === 0}
              key={each}
              onClick={open}
            >
              {t(kindLabels[each])}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog onOpenChange={close} open={kind !== undefined}>
        <DialogContent data-slot="monitor-change-dialog">
          <form className="grid gap-4" onSubmit={apply}>
            <DialogHeader>
              <DialogTitle>{kind ? t(kindLabels[kind]) : null}</DialogTitle>
              <DialogDescription>
                {t("monitor_bulk_description", { count: selected.length })}
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="bulk-value">
                {kind === "set_group"
                  ? t("monitor_field_group")
                  : t(
                      kind === "add_channel" || kind === "remove_channel"
                        ? "monitor_bulk_channel"
                        : "monitor_bulk_tag"
                    )}
              </FieldLabel>
              {field}
              {kind === "set_group" ? (
                <FieldDescription>
                  {t("monitor_bulk_group_hint")}
                </FieldDescription>
              ) : null}
              {refusal ? (
                <FieldError data-slot="monitor-change-refusal">
                  {t(refusal.id, refusal.values)}
                </FieldError>
              ) : null}
            </Field>
            <datalist id="bulk-names">
              {(kind === "set_group" ? groups : tags).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <DialogFooter>
              <Button onClick={cancel} type="button" variant="outline">
                {t("app_cancel")}
              </Button>
              <Button
                data-slot="monitor-change-apply"
                disabled={pending}
                type="submit"
              >
                {t("monitor_bulk_apply")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
