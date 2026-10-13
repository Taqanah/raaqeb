import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "@fumadocs/base-ui/components/dialog/search";
import { useI18n } from "@fumadocs/base-ui/contexts/i18n";
import { useDocsSearch } from "fumadocs-core/search/client";
import { staticClient } from "fumadocs-core/search/client/orama-static";
import { type ReactNode, useCallback, useState } from "react";
import { defaultLocale } from "@/shared/i18n/locale.ts";
import { foldedPattern, searchText } from "./search-text.ts";
import { searchIndexOf } from "./source.ts";

/** The docs search: the visitor's locale's pages, searched in the browser with no server. */
export default function DocsSearch(props: SharedProps): ReactNode {
  const { locale } = useI18n();
  const { query, setSearch } = useDocsSearch({
    client: staticClient({
      from: searchIndexOf(locale ?? defaultLocale),
      locale,
    }),
  });
  // The box shows what the reader typed; the search gets it as the index holds text.
  const [typed, setTyped] = useState("");
  const onSearchChange = useCallback(
    (text: string) => {
      setTyped(text);
      setSearch(searchText(text));
    },
    [setSearch]
  );
  const results = query.data === "empty" ? null : query.data;
  // Fumadocs marks the typed text as typed, which misses a word typed without its diacritics; this marks what the search found, in Fumadocs' own highlight.
  const markFound = useCallback(
    (list: HTMLElement | null) => {
      const pattern = foldedPattern(typed);
      if (!(list && pattern && results) || typeof Highlight === "undefined") {
        return;
      }
      const highlight = CSS.highlights.get("fd-search") ?? new Highlight();
      CSS.highlights.set("fd-search", highlight);
      const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT);
      const ranges: StaticRange[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node instanceof Text)) {
          continue;
        }
        for (const match of node.data.matchAll(pattern)) {
          const range = new StaticRange({
            endContainer: node,
            endOffset: match.index + match[0].length,
            startContainer: node,
            startOffset: match.index,
          });
          highlight.add(range);
          ranges.push(range);
        }
      }
      return () => {
        for (const range of ranges) {
          highlight.delete(range);
        }
      };
    },
    [typed, results]
  );
  return (
    <SearchDialog
      isLoading={query.isLoading}
      onSearchChange={onSearchChange}
      search={typed}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <div className="contents" ref={markFound}>
          <SearchDialogList items={results} />
        </div>
      </SearchDialogContent>
    </SearchDialog>
  );
}
