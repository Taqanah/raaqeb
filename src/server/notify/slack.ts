/**
 * Slack: the notification's chat
 * text as the `text` of a POST to the channel's incoming webhook, with
 * Slack's formatting off, each link `<url|words>`, which formatting
 * off still reads since it is parsing, not mrkdwn. Any Slack-compatible
 * receiver takes the same body.
 */
import { slackDeclaration } from "@/shared/schemas/channel.ts";
import { jsonHeaders, type NotificationChannel } from "./channel.ts";
import { chatText, notificationText } from "./text.ts";

/** Slack reads `&`, `<` and `>` as markup even with formatting off, so a name cannot make a link or a mention. */
function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export const slackChannel: NotificationChannel = {
  declaration: slackDeclaration,
  generate: {},
  send: async (values, payload, transport) => {
    const text = await notificationText(payload);
    const links = text.links.map(
      ({ url, words }) => `\n<${escaped(url)}|${escaped(words)}>`
    );
    await transport.post(values.url ?? "", {
      body: JSON.stringify({
        mrkdwn: false,
        text: escaped(chatText(text)) + links.join(""),
      }),
      headers: jsonHeaders,
    });
  },
};
