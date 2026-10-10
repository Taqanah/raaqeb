/**
 * A status page's subscribers in the admin: each subscription's address, the webhook's host alone, how it
 * receives, its language, where it stands, since when, and how the last
 * message to it went. The operator may remove one, which deletes it with
 * its queued messages and tells no one. Newest first; no paging in v1.
 */
import { type ReactNode, useCallback, useState } from "react";
import { SendFailureText, SendStatus } from "@/admin/channels/send-parts.tsx";
import { useContentIn } from "@/admin/shell/content.tsx";
import { Page } from "@/admin/shell/page.tsx";
import {
  formatDateTime,
  type TimeOptions,
  zoneLabel,
} from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { SubscriptionChannel } from "@/shared/schemas/page.ts";
import type {
  Subscriber,
  SubscriberList,
  SubscriberRemoveResult,
} from "@/shared/schemas/subscription.ts";
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
import { Badge } from "@/shared/ui/badge.tsx";
import { Button } from "@/shared/ui/button.tsx";
import { Empty, EmptyDescription } from "@/shared/ui/empty.tsx";
import { TrashIcon } from "@/shared/ui/icons.tsx";
import { localeNames } from "@/shared/ui/locale-switcher.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table.tsx";
import { Token } from "@/shared/ui/token.tsx";

const channelWords: Readonly<Record<SubscriptionChannel, MessageId>> = {
  email: "public_subscribe_email",
  webhook: "public_subscribe_webhook",
};

const stateWords: Readonly<Record<Subscriber["state"], MessageId>> = {
  confirmed: "page_subscriber_confirmed",
  expired: "page_subscriber_expired",
  pending: "page_subscriber_pending",
  unsubscribed: "page_subscriber_unsubscribed",
};

const stateVariants = {
  confirmed: "up",
  expired: "secondary",
  pending: "degraded",
  unsubscribed: "secondary",
} as const;

export function SubscriberListPage({
  clock,
  list,
  onRemoved,
  remove,
}: {
  readonly clock: TimeOptions;
  readonly list: SubscriberList;
  readonly onRemoved: () => void;
  readonly remove: (id: string) => Promise<SubscriberRemoveResult | undefined>;
}): ReactNode {
  const { t } = useMessages();
  const text = useContentIn();
  return (
    <Page
      parent={{
        label: text(list.page.title),
        to: `/admin/pages/${list.page.id}`,
      }}
      title={t("page_subscribers")}
    >
      {list.subscribers.length === 0 ? (
        <Empty data-slot="subscribers-empty">
          <EmptyDescription>{t("page_subscribers_empty")}</EmptyDescription>
        </Empty>
      ) : (
        <Table data-slot="subscribers" framed stacked>
          <TableHeader>
            <TableRow>
              <TableHead>{t("page_subscribers_address")}</TableHead>
              <TableHead>{t("page_subscribers_by")}</TableHead>
              <TableHead>{t("app_language")}</TableHead>
              <TableHead>{t("page_subscribers_state")}</TableHead>
              <TableHead>{t("page_subscribers_since")}</TableHead>
              <TableHead>{t("page_subscribers_last")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.subscribers.map((subscriber) => (
              <SubscriberRow
                clock={clock}
                key={subscriber.id}
                onRemoved={onRemoved}
                remove={remove}
                subscriber={subscriber}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </Page>
  );
}

function SubscriberRow({
  clock,
  onRemoved,
  remove,
  subscriber,
}: {
  readonly clock: TimeOptions;
  readonly onRemoved: () => void;
  readonly remove: (id: string) => Promise<SubscriberRemoveResult | undefined>;
  readonly subscriber: Subscriber;
}): ReactNode {
  const { t } = useMessages();
  const { lastSend } = subscriber;
  return (
    <TableRow
      data-slot="subscriber"
      data-state={subscriber.state}
      data-subscriber={subscriber.id}
    >
      <TableCell className="min-w-60">
        {/* A long address wraps rather than pushing the row past the frame. */}
        <Token className="wrap-anywhere inline-block max-w-64 whitespace-normal">
          {subscriber.address}
        </Token>
      </TableCell>
      <TableCell>{t(channelWords[subscriber.channel])}</TableCell>
      <TableCell lang={subscriber.locale}>
        {localeNames[subscriber.locale]}
      </TableCell>
      <TableCell>
        <Badge variant={stateVariants[subscriber.state]}>
          {t(stateWords[subscriber.state])}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        <Stamp at={subscriber.createdAt} clock={clock} />
      </TableCell>
      <TableCell>
        {lastSend ? (
          // The badge over its time, so the column stays narrow enough for the row to fit.
          <div className="flex flex-col items-start gap-1">
            <SendStatus send={lastSend} slot="subscriber-send" />
            <span className="text-muted-foreground">
              <Stamp at={lastSend.at} clock={clock} />
            </span>
            {lastSend.failure ? (
              <SendFailureText failure={lastSend.failure} />
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground">
            {t("channel_recent_empty")}
          </span>
        )}
      </TableCell>
      <TableCell>
        <RemoveSubscriber
          address={subscriber.address}
          id={subscriber.id}
          onRemoved={onRemoved}
          remove={remove}
        />
      </TableCell>
    </TableRow>
  );
}

/** A time and its zone label, which drops to its own line when the table is narrow. */
function Stamp({
  at,
  clock,
}: {
  readonly at: number;
  readonly clock: TimeOptions;
}): ReactNode {
  const { locale } = useMessages();
  return (
    <span className="whitespace-normal">
      <span className="whitespace-nowrap">
        {formatDateTime(locale, at, clock)}
      </span>{" "}
      <span className="whitespace-nowrap">
        ({zoneLabel(locale, at, clock.timeZone)})
      </span>
    </span>
  );
}

/** Remove, after the operator confirms. */
function RemoveSubscriber({
  address,
  id,
  onRemoved,
  remove,
}: {
  /** Named in the dialog, so a narrow screen that scrolls the row away still says whom it removes. */
  readonly address: string;
  readonly id: string;
  readonly onRemoved: () => void;
  readonly remove: (id: string) => Promise<SubscriberRemoveResult | undefined>;
}): ReactNode {
  const { t } = useMessages();
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState(false);
  const ask = useCallback(() => setOpen(true), []);
  const confirm = useCallback(async () => {
    const result = await remove(id).catch(() => undefined);
    // A subscription someone else removed meanwhile is gone either way.
    if (result?.ok || result?.reason === "not_found") {
      onRemoved();
      return;
    }
    setRefused(true);
  }, [id, onRemoved, remove]);
  return (
    <div className="flex flex-col items-end gap-1">
      {/* An icon in each row, as the editor's remove-group, so the row keeps its width for the dates. */}
      <Button
        aria-label={t("page_subscribers_remove")}
        data-slot="remove-subscriber"
        onClick={ask}
        size="icon"
        title={t("page_subscribers_remove")}
        type="button"
        variant="ghost"
      >
        <TrashIcon />
      </Button>
      {refused ? (
        <p className="text-destructive text-xs" role="alert">
          {t("page_unavailable")}
        </p>
      ) : null}
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("page_subscribers_remove_title")}
            </AlertDialogTitle>
            <p>
              <Token data-slot="remove-subscriber-address">{address}</Token>
            </p>
            <AlertDialogDescription>
              {t("page_subscribers_remove_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("app_cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-slot="confirm-remove-subscriber"
              onClick={confirm}
              variant="destructive"
            >
              {t("page_subscribers_remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
