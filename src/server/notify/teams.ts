/**
 * Microsoft Teams: the notification as an Adaptive Card posted to a
 * workflow's webhook (the Workflows app's "When a Teams webhook request is
 * received" trigger), which posts it to a channel or chat. The title, the
 * sentence and each line are text blocks with Teams' markdown escaped, the
 * admin links are buttons that open them, and an Arabic card reads right to
 * left. The Office 365 connectors' webhooks are retired; this is their
 * replacement.
 */
import { directionOf } from "@/shared/i18n/locale.ts";
import { teamsDeclaration } from "@/shared/schemas/channel.ts";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import { jsonHeaders, type NotificationChannel } from "./channel.ts";
import { notificationText } from "./text.ts";

/** A URL, which Teams links whole, or one character its markdown reads: emphasis, code, a link, a mention's tag or a heading. */
const markup = /(https?:\/\/[^\s<]+)|[\\*_~`|<>#[\]]/g;

/** The text with Teams' markdown escaped outside URLs, so a name shows as typed and a link still opens. */
function escaped(text: string): string {
  return text.replace(markup, (match, url: string | undefined) =>
    url === undefined ? `\\${match}` : url
  );
}

/** The colour of the card's title by event: trouble, back to normal, or a warning. */
const colours: Readonly<
  Record<
    Exclude<NotificationPayload["type"], "channel.test">,
    "Attention" | "Good" | "Warning"
  >
> = {
  "monitor.certificate_expiring": "Warning",
  "monitor.degraded_ended": "Good",
  "monitor.degraded_started": "Warning",
  "monitor.domain_expiring": "Warning",
  "monitor.down": "Attention",
  "monitor.recovered": "Good",
  "monitor.reminder": "Attention",
};

export const teamsChannel: NotificationChannel = {
  declaration: teamsDeclaration,
  generate: {},
  send: async (values, payload, transport) => {
    const text = await notificationText(payload);
    const { notification } = payload;
    const colour =
      notification.type === "channel.test"
        ? undefined
        : colours[notification.type];
    const block = (words: string) => ({
      text: escaped(words),
      type: "TextBlock",
      wrap: true,
    });
    const actions = text.links.map(({ url, words }) => ({
      title: words,
      type: "Action.OpenUrl",
      url,
    }));
    await transport.post(values.url ?? "", {
      body: JSON.stringify({
        attachments: [
          {
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              body: [
                {
                  ...block(text.subject),
                  size: "Medium",
                  weight: "Bolder",
                  // An event with no colour leaves the key out of the JSON.
                  color: colour,
                },
                block(text.sentence),
                ...text.lines.map((line) => ({
                  ...block(line),
                  spacing: "None",
                })),
              ],
              msteams: { width: "Full" },
              type: "AdaptiveCard",
              // 1.5 is the version that has `rtl`.
              version: "1.5",
              ...(directionOf(payload.locale) === "rtl" ? { rtl: true } : {}),
              ...(actions.length === 0 ? {} : { actions }),
            },
            contentType: "application/vnd.microsoft.card.adaptive",
            contentUrl: null,
          },
        ],
        type: "message",
      }),
      headers: jsonHeaders,
    });
  },
};
