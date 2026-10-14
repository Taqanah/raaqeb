/**
 * The list's toolbar: the search field `/` focuses, the group
 * and tag filters, and the sort, all the route's search parameters.
 */
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  MonitorListSearch,
  MonitorSort,
} from "@/shared/schemas/monitor.ts";
import { SearchIcon } from "@/shared/ui/icons.tsx";
import { Input } from "@/shared/ui/input.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";

export interface ToolbarProps {
  readonly groups: readonly string[];
  readonly onSearch: (next: MonitorListSearch) => void;
  readonly search: MonitorListSearch;
  readonly tags: readonly string[];
}

const all = "";

export function Toolbar({
  groups,
  onSearch,
  search,
  tags,
}: ToolbarProps): ReactNode {
  const { t } = useMessages();
  // The field keeps its own text: the URL follows each keystroke through an
  // async navigation, and a field controlled by the URL alone drops letters
  // typed while one is in flight. The URL wins when it changes elsewhere
  // (clear filters, the back button).
  const [query, setQuery] = useState(search.q ?? all);
  useEffect(() => {
    setQuery(search.q ?? all);
  }, [search.q]);
  const set = useCallback(
    (patch: Partial<MonitorListSearch>) => {
      const next = { ...search, ...patch };
      for (const key of Object.keys(next) as (keyof MonitorListSearch)[]) {
        if (next[key] === undefined || next[key] === all) {
          delete next[key];
        }
      }
      onSearch(next);
    },
    [onSearch, search]
  );
  const onQuery = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setQuery(event.currentTarget.value);
      set({ q: event.currentTarget.value });
    },
    [set]
  );
  const onGroup = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      set({ group: event.currentTarget.value }),
    [set]
  );
  const onTag = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      set({ tag: event.currentTarget.value }),
    [set]
  );
  const onSort = useCallback(
    (value: unknown) =>
      set({ sort: value === "newest" ? "newest" : undefined }),
    [set]
  );
  // A shared link may name a group or a tag no listed monitor carries; the select still shows it, so the filter is visible.
  const groupOptions =
    search.group !== undefined && !groups.includes(search.group)
      ? [search.group, ...groups]
      : groups;
  const tagOptions =
    search.tag !== undefined && !tags.includes(search.tag)
      ? [search.tag, ...tags]
      : tags;
  return (
    // A phone lays the filters out evenly: the search, then the group and the tag side by side, then the sort across.
    <div
      className="flex flex-wrap items-center gap-2 max-sm:grid max-sm:grid-cols-2"
      data-slot="monitor-toolbar"
    >
      {/* Wide enough for the whole placeholder, so a filter that would squeeze it wraps to the next line instead. */}
      <div className="relative min-w-60 flex-1 max-sm:col-span-2">
        <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-icon -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={t("app_search")}
          className="ps-9"
          data-search=""
          name="q"
          onChange={onQuery}
          placeholder={t("monitor_search_placeholder")}
          type="search"
          value={query}
        />
      </div>
      <NativeSelect
        aria-label={t("monitor_filter_group")}
        className="max-sm:w-full"
        name="group"
        onChange={onGroup}
        value={search.group ?? all}
      >
        <NativeSelectOption value={all}>
          {t("monitor_filter_all_groups")}
        </NativeSelectOption>
        {groupOptions.map((group) => (
          <NativeSelectOption key={group} value={group}>
            {group}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label={t("monitor_filter_tag")}
        className="max-sm:w-full"
        name="tag"
        onChange={onTag}
        value={search.tag ?? all}
      >
        <NativeSelectOption value={all}>
          {t("monitor_filter_all_tags")}
        </NativeSelectOption>
        {tagOptions.map((tag) => (
          <NativeSelectOption key={tag} value={tag}>
            {tag}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {/* Two orders, side by side, one click each. Each option keeps its own width: the control's default equal shares squeeze the longer label into its padding and against the edge. */}
      <Segmented
        aria-label={t("monitor_sort")}
        className="w-auto max-sm:col-span-2 max-sm:w-full"
        data-name="sort"
        name="sort"
        onValueChange={onSort}
        value={(search.sort ?? "name") satisfies MonitorSort}
      >
        <SegmentedItem
          className="flex-none whitespace-nowrap max-sm:flex-1"
          value="name"
        >
          {t("monitor_sort_name")}
        </SegmentedItem>
        <SegmentedItem
          className="flex-none whitespace-nowrap max-sm:flex-1"
          value="newest"
        >
          {t("monitor_sort_newest")}
        </SegmentedItem>
      </Segmented>
    </div>
  );
}
