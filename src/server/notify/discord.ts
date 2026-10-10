/**
 * Discord: the notification's chat
 * text as the `content` of a POST to the channel's webhook, its markdown
 * escaped, each link a masked link of the words that open it, no one
 * mentioned and no link preview.
 */
import { discordDeclaration } from "@/shared/schemas/channel.ts";
import { jsonHeaders, type NotificationChannel } from "./channel.ts";
import { chatText, clip, notificationText } from "./text.ts";

/** The longest content Discord takes. */
const contentMax = 2000;

/** Discord's SUPPRESS_EMBEDS message flag: no link preview. */
const suppressEmbeds = 4;

/** A URL, which Discord links whole before any markdown and ends at `<` as Discord does, or one character its markdown reads. */
const markup = /(https?:\/\/[^\s<]+)|[\\*_~`|<>#[\]-]/g;

/** The text with Discord's markdown escaped outside URLs, so a name shows as typed and a link still opens. */
function escaped(text: string): string {
  return text.replace(markup, (match, url: string | undefined) =>
    url === undefined ? `\\${match}` : url
  );
}

export const discordChannel: NotificationChannel = {
  declaration: discordDeclaration,
  generate: {},
  send: async (values, payload, transport) => {
    const text = await notificationText(payload);
    // The angle brackets keep a masked link from making a preview.
    // The angle brackets end at `>`, but a `)` would still end the link; percent-encoded it is the same address.
    const links = text.links
      .map(
        ({ url, words }) =>
          `\n[${escaped(words)}](<${url.replaceAll("(", "%28").replaceAll(")", "%29")}>)`
      )
      .join("");
    // The cut runs before escaping, measured as escaped, so it never parts a backslash from its character, and spares the links.
    const content =
      escaped(
        clip(
          chatText(text),
          contentMax - links.length,
          (each) => escaped(each).length
        )
      ) + links;
    await transport.post(values.url ?? "", {
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        content,
        flags: suppressEmbeds,
      }),
      headers: jsonHeaders,
    });
  },
};
