/**
 * An email's HTML part, beside the plain-text part it shows: a
 * client reads a text/plain body left to right whatever its language, so
 * every email carries this part too. The layout is a card
 * with the heading, the sentence, an update's
 * own words, the lines the plain-text part writes, and the links as
 * buttons; a footer under it. `lang` and `dir` follow the locale on the
 * root, the body and every table and cell, since Gmail drops the root's; a
 * line's machine value (a URL, a target, a code) stays left to right; every
 * value is escaped. Light and dark, from the design language's colours.
 */
import { directionOf, type Locale } from "@/shared/i18n/locale.ts";
import {
  emailDarkQuery,
  type NotificationLink,
} from "@/shared/schemas/channel.ts";

/** One line as the plain-text part writes it, and the machine value in it, which the HTML part keeps left to right. */
export interface MailLine {
  readonly text: string;
  readonly token?: string;
}

/** What an email's HTML part shows. */
export interface MailContent {
  /** The links, each as a button with the words that open it; the first is the primary one. */
  readonly buttons: readonly NotificationLink[];
  /** Under the card: a sentence and the link it ends with. */
  readonly footer?: {
    readonly link: NotificationLink;
    readonly text: string;
  };
  /** What the email is about, from data: a monitor's name or an incident's title. */
  readonly heading?: string;
  readonly lines: readonly MailLine[];
  readonly locale: Locale;
  readonly sentence: string;
  /** The document's title. */
  readonly subject: string;
  /** An incident update's own words, each paragraph in the direction of its first letter. */
  readonly update?: string;
}

/** The design language's colours (src/styles.css): light inline, dark from the media query. */
const light = {
  action: "#0f766e",
  border: "#e5e5e5",
  card: "#ffffff",
  foreground: "#171717",
  muted: "#737373",
  tint: "#fafafa",
};
const dark = {
  border: "#262626",
  card: "#0a0a0a",
  foreground: "#fafafa",
  link: "#2dd4bf",
  muted: "#a3a3a3",
  tint: "#000000",
};
// No web font loads in most clients: Rubik where installed, else each system's own Arabic face.
const sans =
  "Rubik, -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, Arial, sans-serif";
const mono =
  "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const slashes = /\/+/g;

/** A line with its machine value left to right in mono, breakable only after a slash. */
function lineHtml(line: MailLine): string {
  const at =
    line.token === undefined || line.token === ""
      ? -1
      : line.text.lastIndexOf(line.token);
  if (line.token === undefined || at < 0) {
    return Bun.escapeHTML(line.text);
  }
  const value = Bun.escapeHTML(line.token).replace(slashes, "$&<wbr>");
  return `${Bun.escapeHTML(line.text.slice(0, at))}<span dir="ltr" style="unicode-bidi:isolate;font-family:${mono};font-size:13px;">${value}</span>${Bun.escapeHTML(line.text.slice(at + line.token.length))}`;
}

const paragraphBreak = /\n{2,}/;

/** The update's paragraphs, each in the direction of its first letter, as the status page shows them. */
function updateHtml(update: string): string {
  return update
    .split(paragraphBreak)
    .map(
      (each) =>
        `<p dir="auto" class="fg" style="margin:0 0 10px;font-family:${sans};font-size:15px;line-height:26px;color:${light.foreground};">${Bun.escapeHTML(each).replaceAll("\n", "<br>")}</p>`
    )
    .join("");
}

const darkStyles = `${emailDarkQuery} {
  .bg { background-color:${dark.tint} !important; }
  .card { background-color:${dark.card} !important; border-color:${dark.border} !important; }
  .fg { color:${dark.foreground} !important; }
  .muted { color:${dark.muted} !important; }
  .rule { border-color:${dark.border} !important; }
  .link { color:${dark.link} !important; }
}`;

/** The HTML part of an email. */
export function mailHtml(mail: MailContent): string {
  const dir = directionOf(mail.locale);
  const start = dir === "rtl" ? "right" : "left";
  // Outlook's Word engine knows no logical alignment, so each text cell carries the physical one.
  const cell = (style: string, className: string) =>
    `<td dir="${dir}" align="${start}" class="${className}" style="text-align:${start};font-family:${sans};${style}">`;
  const table = (attributes: string) =>
    `<table role="presentation" dir="${dir}" cellpadding="0" cellspacing="0" border="0"${attributes}>`;
  const lines = mail.lines
    .map(
      (each) =>
        `<tr>${cell(`padding:10px 0;border-top:1px solid ${light.border};font-size:14px;line-height:22px;color:${light.foreground};`, "fg rule")}${lineHtml(each)}</td></tr>`
    )
    .join("\n");
  const [primary, ...others] = mail.buttons;
  const buttons =
    primary === undefined
      ? ""
      : `<tr>${cell("padding:22px 0 0;", "")}
${table("")}<tr>
<td style="border-radius:8px;background-color:${light.action};"><a href="${Bun.escapeHTML(primary.url)}" style="display:inline-block;padding:10px 18px;font-family:${sans};font-size:14px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${Bun.escapeHTML(primary.words)}</a></td>
${others
  .map(
    (each) =>
      `${cell(`padding-${start}:16px;font-size:14px;line-height:20px;`, "")}<a href="${Bun.escapeHTML(each.url)}" class="link" style="color:${light.action};font-weight:600;text-decoration:none;">${Bun.escapeHTML(each.words)}</a></td>`
  )
  .join("\n")}
</tr></table>
</td></tr>`;
  const footer =
    mail.footer === undefined
      ? ""
      : `<tr>${cell(`padding:18px 4px 0;font-size:12px;line-height:20px;color:${light.muted};`, "muted")}${Bun.escapeHTML(mail.footer.text)} <a href="${Bun.escapeHTML(mail.footer.link.url)}" class="muted" style="white-space:nowrap;color:${light.muted};text-decoration:underline;">${Bun.escapeHTML(mail.footer.link.words)}</a></td></tr>`;
  return `<!doctype html>
<html lang="${mail.locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<title>${Bun.escapeHTML(mail.subject)}</title>
<style>
body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
table { border-collapse:collapse; }
a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
@media only screen and (max-width:480px) {
  .px { padding-left:20px !important; padding-right:20px !important; }
  .outer { padding:16px 8px 24px !important; }
}
${darkStyles}
</style>
</head>
<body dir="${dir}" class="bg" style="margin:0;padding:0;background-color:${light.tint};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${Bun.escapeHTML(mail.sentence)}</div>
${table(` width="100%" class="bg" style="background-color:${light.tint};"`)}
<tr><td align="center" class="outer" style="padding:32px 12px 40px;">
<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
${table(` width="100%" style="max-width:560px;"`)}
<tr><td class="card px" style="background-color:${light.card};border:1px solid ${light.border};border-radius:12px;padding:28px 32px;">
${table(` width="100%"`)}
${mail.heading === undefined ? "" : `<tr>${cell(`font-size:20px;line-height:28px;font-weight:700;color:${light.foreground};`, "fg")}${Bun.escapeHTML(mail.heading)}</td></tr>`}
<tr>${cell(`padding:6px 0 18px;font-size:15px;line-height:24px;color:${light.muted};`, "muted")}${Bun.escapeHTML(mail.sentence)}</td></tr>
${mail.update === undefined ? "" : `<tr>${cell("padding:0 0 12px;", "")}${updateHtml(mail.update)}</td></tr>`}
${lines}
${buttons}
</table>
</td></tr>
${footer}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;
}
