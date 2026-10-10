/**
 * Telegram: the notification's chat
 * text sent by the channel's bot to one chat through the Bot API's
 * sendMessage, as HTML so each link is the words that open it, with
 * every other character escaped and no link preview.
 */
import { telegramDeclaration } from "@/shared/schemas/channel.ts";
import { jsonHeaders, type NotificationChannel } from "./channel.ts";
import { chatText, clip, notificationText } from "./text.ts";

/** The longest text sendMessage takes, counted after its HTML is read. */
const textMax = 4096;

/** The Bot API's sendMessage URL for a bot token. */
export function telegramUrl(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

/** Whether a chat makes a link of the URL: Telegram drops one whose host has no dot unless it is IPv6 (tdlib's `check_link_impl`), and would show the words with no address. */
export function telegramLinks(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const { hostname } = new URL(url);
  return hostname.includes(".") || hostname.startsWith("[");
}

/** Text as Telegram's HTML reads it back: every `&`, `<` and `>` outside a tag must be an entity. */
function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export const telegramChannel: NotificationChannel = {
  declaration: telegramDeclaration,
  generate: {},
  send: async (values, payload, transport) => {
    const text = await notificationText(payload);
    // A link Telegram would drop stays its plain line.
    const links = text.links.map(({ line, url, words }) =>
      telegramLinks(url)
        ? {
            html: `\n<a href="${escaped(url).replaceAll('"', "&quot;")}">${escaped(words)}</a>`,
            shown: words,
          }
        : { html: `\n${escaped(line)}`, shown: line }
    );
    // Telegram counts the text a chat shows, so a link counts by what it shows; the cut happens before escaping, so it never splits an entity, and spares the links.
    const shown = links.reduce((sum, link) => sum + 1 + link.shown.length, 0);
    await transport.post(telegramUrl(values.botToken ?? ""), {
      body: JSON.stringify({
        chat_id: values.chatId,
        link_preview_options: { is_disabled: true },
        parse_mode: "HTML",
        text:
          escaped(clip(chatText(text), textMax - shown)) +
          links.map((link) => link.html).join(""),
      }),
      headers: jsonHeaders,
    });
  },
};
