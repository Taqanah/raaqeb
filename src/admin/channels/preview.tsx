/**
 * The notification preview on the channel page (CONTEXT.md "Notification
 * preview"): each operator notification the channel can receive,
 * as the server wrote it with sample values, one disclosure each and marked
 * as a sample. Text keeps the direction its first words give it; the
 * webhook's JSON body reads left to right in the monospace face; an email
 * shows its HTML part as the client would. A link
 * shows as the words that open it, after the text or as ntfy's buttons
 * under it; a sample's link names no real monitor, so it does not
 * navigate and its address shows on hover.
 */
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { themeSchema } from "@/shared/schemas/appearance.ts";
import type {
  NotificationLink,
  NotificationPreview,
} from "@/shared/schemas/channel.ts";
import { Badge } from "@/shared/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { ChevronDownIcon, ChevronEndIcon } from "@/shared/ui/icons.tsx";
import { emailInTheme } from "./email-theme.ts";

const labels: Readonly<Record<NotificationPreview["type"], MessageId>> = {
  "monitor.certificate_expiring": "monitor_event_certificate_expiring",
  "monitor.degraded_ended": "monitor_event_degraded_ended",
  "monitor.degraded_started": "monitor_event_degraded_started",
  "monitor.down": "monitor_event_down",
  "monitor.recovered": "monitor_event_recovered",
  "monitor.reminder": "channel_preview_reminder",
};

export function NotificationPreviewCard({
  machine,
  preview,
}: {
  /** The body is a machine payload, not text in a language. */
  readonly machine: boolean;
  readonly preview: readonly NotificationPreview[];
}): ReactNode {
  const { t } = useMessages();
  return (
    <Card data-slot="notification-preview">
      <CardHeader divided>
        <CardTitle className="flex items-center gap-2">
          {t("channel_preview_title")}
          <Badge data-slot="preview-sample" variant="outline">
            {t("channel_preview_sample")}
          </Badge>
        </CardTitle>
        <CardDescription>{t("channel_preview_hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border">
        {preview.map((each) => (
          <details
            className="group py-3 first:pt-0 last:pb-0"
            data-preview={each.type}
            key={each.type}
          >
            {/* The app's chevron instead of the browser's triangle: along the reading direction closed, down open. */}
            <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-sm [&::-webkit-details-marker]:hidden">
              <ChevronEndIcon className="size-icon text-muted-foreground group-open:hidden" />
              <ChevronDownIcon className="hidden size-icon text-muted-foreground group-open:block" />
              {t(labels[each.type])}
            </summary>
            <div className="mt-3 flex flex-col gap-2 rounded-lg bg-subtle p-3">
              {each.subject === undefined ? null : (
                <p className="font-medium text-sm" dir="auto">
                  {each.subject}
                </p>
              )}
              {each.html === undefined ? (
                <PreviewBody
                  body={each.body}
                  links={each.links}
                  machine={machine}
                />
              ) : (
                <EmailFrame html={each.html} title={each.subject ?? ""} />
              )}
              {each.buttons.length === 0 ? null : (
                <div className="flex flex-wrap gap-2">
                  {each.buttons.map((button) => (
                    <span
                      className="rounded-md border border-border bg-background px-2.5 py-1 font-medium text-sm"
                      data-slot="preview-button"
                      key={button.url}
                      title={button.url}
                    >
                      {button.words}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * An email's HTML part as a mail client shows it: sandboxed, so no
 * script runs and nothing navigates, in the admin's own light or dark theme,
 * and as tall as its content at the width it is given, which is none while
 * its disclosure is closed.
 */
export function EmailFrame({
  html,
  title,
}: {
  readonly html: string;
  readonly title: string;
}): ReactNode {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();
  // The theme is the document's, read after mount (ADR-0006).
  useEffect(() => {
    const element = frame.current;
    if (!element) {
      return;
    }
    // A frame laid out again by an opened disclosure has its new height a frame later.
    const measure = () =>
      requestAnimationFrame(() =>
        setHeight(element.contentDocument?.documentElement.scrollHeight)
      );
    const resized = new ResizeObserver(measure);
    element.addEventListener("load", measure);
    resized.observe(element);
    const theme = themeSchema.safeParse(document.documentElement.dataset.theme);
    element.srcdoc = emailInTheme(html, theme.success ? theme.data : "system");
    return () => {
      element.removeEventListener("load", measure);
      resized.disconnect();
    };
  }, [html]);
  return (
    <iframe
      className="block w-full rounded-lg border-0"
      data-slot="preview-email"
      ref={frame}
      // Same origin without scripts: the page can read the content's height, and the email can run nothing.
      sandbox="allow-same-origin"
      style={{ height }}
      title={title}
    />
  );
}

const urls = /(https?:\/\/\S+)/;

/** The body cut into its links and the text between, each with its offset as a stable key. */
function pieces(body: string): { at: number; link: boolean; text: string }[] {
  const out: { at: number; link: boolean; text: string }[] = [];
  let at = 0;
  // split with a capture group puts each link at an odd position.
  for (const [position, text] of body.split(urls).entries()) {
    out.push({ at, link: position % 2 === 1, text });
    at += text.length;
  }
  return out;
}

/**
 * A notification's body as it is sent. In prose each link is isolated left to right and may break
 * anywhere, so a wrapped link keeps its hyphens in place in a right-to-left line; a machine body is
 * left whole. The isolation adds no characters: the text is the one the channel sends. The
 * words that open a link follow on lines of their own, as a chat shows them.
 */
export function PreviewBody({
  body,
  links = [],
  machine,
}: {
  readonly body: string;
  readonly links?: readonly NotificationLink[];
  readonly machine: boolean;
}): ReactNode {
  return (
    <pre
      className={cn(
        "whitespace-pre-wrap break-words",
        machine ? "font-mono text-xs" : "font-sans text-sm"
      )}
      data-slot="preview-body"
      dir={machine ? "ltr" : "auto"}
    >
      {machine
        ? body
        : pieces(body).map(({ at, link, text }) =>
            link ? (
              <bdi className="break-all" dir="ltr" key={at}>
                {text}
              </bdi>
            ) : (
              text
            )
          )}
      {links.map((link) => (
        <Fragment key={link.url}>
          {"\n"}
          <span
            className="underline underline-offset-4"
            data-slot="preview-link"
            title={link.url}
          >
            {link.words}
          </span>
        </Fragment>
      ))}
    </pre>
  );
}
