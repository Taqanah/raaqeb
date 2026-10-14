/**
 * The time zone field: Base UI's combobox over the
 * zones as the operator reads them, the city in the operator language, the
 * region and the offset, searched in Arabic or English. The zones that
 * matter here come first; the form still submits the IANA name under its
 * `name`, and the account page's "as the install" submits nothing.
 */
import { Combobox } from "@base-ui/react/combobox";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { CheckIcon, ChevronDownIcon } from "@/shared/ui/icons.tsx";
import {
  matchesZone,
  type ZoneOption,
  zoneOption,
  zoneOptions,
} from "./zones.ts";

interface ZoneGroup {
  readonly items: ZoneOption[];
  readonly label: string;
}

export interface TimeZonePickerProps {
  readonly defaultValue: string;
  /** "As the install", with the zone it follows; only the account page offers it. */
  readonly follow?: { readonly label: string; readonly zone: string };
  readonly labelledBy: string;
  readonly name: string;
  readonly onZone?: (zone: string) => void;
  /** The zones listed first: the install's and the server's. */
  readonly suggested: readonly string[];
  readonly zones: readonly string[];
}

export function TimeZonePicker({
  defaultValue,
  follow,
  labelledBy,
  name,
  onZone,
  suggested,
  zones,
}: TimeZonePickerProps): ReactNode {
  const { locale, t } = useMessages();
  // Offsets are read once, when the field mounts; a clock change while it is open is not worth a re-read.
  const [now] = useState(() => Date.now());
  // The bare offsets (Etc/GMT+3) are no place anyone lives; one is listed only while it is the saved choice.
  const all = useMemo(
    () =>
      zoneOptions(
        zones.filter(
          (zone) => !zone.startsWith("Etc/") || zone === defaultValue
        ),
        locale,
        now
      ),
    [defaultValue, locale, now, zones]
  );
  const followOption = useMemo<ZoneOption | undefined>(() => {
    if (!follow) {
      return;
    }
    const followed = zoneOption(follow.zone, locale, now);
    return {
      ...followed,
      city: follow.label,
      label: `${follow.label}: ${followed.label}`,
      value: "",
    };
  }, [follow, locale, now]);
  const groups = useMemo<ZoneGroup[]>(() => {
    const first = [
      ...(followOption ? [followOption] : []),
      ...all.filter((option) => suggested.includes(option.value)),
    ];
    return [
      { items: first, label: t("setting_zone_suggested") },
      { items: [...all], label: t("setting_zone_all") },
    ];
  }, [all, followOption, suggested, t]);
  // The zone's name is kept, not its option, so its words follow the language the page is shown in.
  const [chosenZone, setChosenZone] = useState(defaultValue);
  const chosen =
    (chosenZone === "" ? followOption : undefined) ??
    all.find((option) => option.value === chosenZone);
  const change = useCallback(
    (value: ZoneOption | null) => {
      if (value) {
        setChosenZone(value.value);
        onZone?.(value.value);
      }
    },
    [onZone]
  );
  return (
    <Combobox.Root
      // The first match is highlighted, so a search and Enter choose it.
      autoHighlight
      filter={filterZone}
      isItemEqualToValue={sameZone}
      items={groups}
      itemToStringLabel={zoneLabelOf}
      itemToStringValue={zoneValue}
      name={name}
      onValueChange={change}
      value={chosen ?? null}
    >
      <Combobox.Trigger
        aria-labelledby={labelledBy}
        className="flex h-control w-full items-center justify-between gap-3 rounded-lg border border-input bg-background px-3 text-start text-sm transition-[border-color,box-shadow] hover:border-border-strong focus-visible:border-ring"
        data-slot="time-zone-picker"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium">
            {chosen?.city ?? chosen?.label}
          </span>
          {chosen?.region ? (
            <span className="truncate text-muted-foreground max-sm:hidden">
              {chosen.region}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs tabular-nums">
          {chosen?.offset}
          <ChevronDownIcon className="size-icon" />
        </span>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" className="z-50" sideOffset={4}>
          <Combobox.Popup className="w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-(--rim) ring-1 transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0">
            <Combobox.Input
              className="h-control w-full border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
              data-slot="time-zone-search"
              placeholder={t("setting_zone_search")}
            />
            <Combobox.Empty className="px-3 py-6 text-center text-muted-foreground text-sm empty:hidden">
              {t("setting_zone_empty")}
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(22rem,var(--available-height))] overflow-auto overscroll-contain p-1 outline-none empty:hidden">
              {(group: ZoneGroup) =>
                group.items.length === 0 ? null : (
                  <Combobox.Group
                    className="py-1"
                    items={group.items}
                    key={group.label}
                  >
                    <Combobox.GroupLabel className="px-2 py-1 text-muted-foreground text-xs">
                      {group.label}
                    </Combobox.GroupLabel>
                    <Combobox.Collection>
                      {(option: ZoneOption) => (
                        <ZoneItem
                          key={`${group.label}-${option.value}`}
                          option={option}
                        />
                      )}
                    </Combobox.Collection>
                  </Combobox.Group>
                )
              }
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

function ZoneItem({ option }: { readonly option: ZoneOption }): ReactNode {
  return (
    <Combobox.Item
      className={cn(
        "grid cursor-default select-none grid-cols-[1rem_auto_1fr_auto] items-baseline gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent"
      )}
      value={option}
    >
      <Combobox.ItemIndicator className="self-center text-action [&_svg]:size-icon-sm">
        <CheckIcon />
      </Combobox.ItemIndicator>
      <span className="col-start-2 font-medium">
        {option.city ?? option.label}
      </span>
      <span className="truncate text-muted-foreground text-xs">
        {option.city ? option.region : ""}
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">
        {option.offset}
      </span>
    </Combobox.Item>
  );
}

function filterZone(option: ZoneOption, query: string): boolean {
  return option.value === "" ? query.trim() === "" : matchesZone(option, query);
}

function sameZone(a: ZoneOption, b: ZoneOption): boolean {
  return a.value === b.value;
}

function zoneLabelOf(option: ZoneOption): string {
  return option.label;
}

function zoneValue(option: ZoneOption): string {
  return option.value;
}
