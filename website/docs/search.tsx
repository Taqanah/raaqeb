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
import { searchText } from "./search-text.ts";
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
        <SearchDialogList items={query.data === "empty" ? null : query.data} />
      </SearchDialogContent>
    </SearchDialog>
  );
}
