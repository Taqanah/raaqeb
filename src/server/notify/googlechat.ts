/**
 * Google Chat: the notification as a card (`cardsV2`) posted to a space's
 * incoming webhook: the subject as the card's title, the sentence and the
 * lines as one paragraph with the HTML Chat reads escaped, the admin links
 * as buttons that open them, and the whole as plain text in `fallbackText`
 * for a phone's notification, where the card is not shown.
 */
import { googlechatDeclaration } from "@/shared/schemas/channel.ts";
import { jsonHeaders, type NotificationChannel } from "./channel.ts";
import { chatText, notificationText } from "./text.ts";

/** Text as Chat's HTML reads it back: a card paragraph is HTML, so `&`, `<` and `>` must be entities. */
function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export const googlechatChannel: NotificationChannel = {
  declaration: googlechatDeclaration,
  generate: {},
  send: async (values, payload, transport) => {
    const text = await notificationText(payload);
    const buttons = text.links.map(({ url, words }) => ({
      onClick: { openLink: { url } },
      text: words,
    }));
    await transport.post(values.url ?? "", {
      body: JSON.stringify({
        cardsV2: [
          {
            card: {
              // The title is plain text, so the subject goes in as typed.
              header: { title: text.subject },
              sections: [
                {
                  widgets: [
                    {
                      textParagraph: {
                        text: [text.sentence, "", ...text.lines]
                          .map(escaped)
                          .join("<br>"),
                      },
                    },
                    ...(buttons.length === 0
                      ? []
                      : [{ buttonList: { buttons } }]),
                  ],
                },
              ],
            },
          },
        ],
        fallbackText: [
          chatText(text),
          ...text.links.map((link) => link.line),
        ].join("\n"),
      }),
      headers: jsonHeaders,
    });
  },
};
