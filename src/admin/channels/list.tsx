/**
 * The channels list: every channel the install owns, with its
 * type, where it sends (never a secret: the webhook's host), its channel
 * language, whether new monitors start with it, and how its newest
 * notification went. The name opens the channel's page.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Page } from "@/admin/shell/page.tsx";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type Channel,
  type ChannelListResult,
  channelDeclarations,
} from "@/shared/schemas/channel.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Badge } from "@/shared/ui/badge.tsx";
import { buttonVariants } from "@/shared/ui/button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/shared/ui/empty.tsx";
import { localeNames } from "@/shared/ui/locale-switcher.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  tableRowLink,
} from "@/shared/ui/table.tsx";
import { Token } from "@/shared/ui/token.tsx";

import { SendStatus } from "./send-parts.tsx";

const newChannelPath = "/admin/channels/new";

export function ChannelList({
  result,
}: {
  readonly result: ChannelListResult;
}): ReactNode {
  const { t } = useMessages();
  const add = (
    <Link
      className={buttonVariants()}
      data-slot="add-channel"
      to={newChannelPath}
    >
      {t("channel_add")}
    </Link>
  );
  // While the list is empty its card holds the one add button, which says what to add.
  const empty = result.ok && result.channels.length === 0;
  return (
    <Page action={empty ? undefined : add} title={t("channel_list_title")}>
      <ListBody add={add} result={result} />
    </Page>
  );
}

function ListBody({
  add,
  result,
}: {
  readonly add: ReactNode;
  readonly result: ChannelListResult;
}): ReactNode {
  const { t } = useMessages();
  if (!result.ok) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {result.reason === "corrupt" ? (
            <>
              {t("channel_corrupt")} <Token>{result.id}</Token>
            </>
          ) : (
            t("channel_unavailable")
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (result.channels.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("channel_empty_title")}</EmptyTitle>
          <EmptyDescription>{t("channel_empty_description")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{add}</EmptyContent>
      </Empty>
    );
  }
  // The webhook's payload is never localized, so the column shows only once a channel type that writes text is in the list.
  const localized = result.channels.some(
    ({ channel }) => channelDeclarations[channel.type].localized
  );
  return (
    <Table data-slot="channel-list" framed stacked>
      <TableHeader>
        <TableRow>
          <TableHead>{t("channel_column_name")}</TableHead>
          <TableHead>{t("channel_column_type")}</TableHead>
          <TableHead>{t("channel_column_destination")}</TableHead>
          {localized ? (
            <TableHead>{t("channel_column_language")}</TableHead>
          ) : null}
          <TableHead>{t("channel_column_last_send")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {result.channels.map(({ channel, last, summary }) => (
          <TableRow data-channel={channel.id} key={channel.id}>
            <TableCell>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  className={tableRowLink}
                  data-slot="channel-name"
                  params={{ id: channel.id }}
                  to="/admin/channels/$id"
                >
                  <bdi>{channel.name}</bdi>
                </Link>
                {channel.appliesToNew ? (
                  <Badge variant="secondary">
                    {t("channel_applies_badge")}
                  </Badge>
                ) : null}
              </div>
            </TableCell>
            <TableCell>
              <Badge variant="outline">
                {t(channelDeclarations[channel.type].label)}
              </Badge>
            </TableCell>
            <TableCell>
              {summary === "" ? null : (
                <Token data-slot="channel-summary">{summary}</Token>
              )}
            </TableCell>
            {localized ? (
              <TableCell>
                <ChannelLanguage channel={channel} />
              </TableCell>
            ) : null}
            <TableCell>
              {last ? (
                <SendStatus send={last} slot="last-send" />
              ) : (
                <span className="text-muted-foreground text-sm">
                  {t("channel_never_sent")}
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The channel language, for a type whose messages are text; the webhook's payload has none. */
function ChannelLanguage({
  channel,
}: {
  readonly channel: Channel;
}): ReactNode {
  const { t } = useMessages();
  if (!channelDeclarations[channel.type].localized) {
    // A dash, so the cell does not read as missing data; the words are for a screen reader and on hover.
    return (
      <span
        className="text-muted-foreground max-sm:hidden"
        title={t("channel_locale_none")}
      >
        <span aria-hidden>—</span>
        <span className="sr-only">{t("channel_locale_none")}</span>
      </span>
    );
  }
  return channel.locale === undefined
    ? t("channel_locale_install")
    : localeNames[channel.locale];
}
