/**
 * An email's HTML part in the admin's theme. The email draws its dark
 * colours under the system's dark preference, which a frame in the admin
 * reads from the system, not from the admin's own setting; so the preview
 * turns that query on for a dark admin and off for a light one, and leaves
 * it to the system when the admin follows the system too.
 */
import type { Theme } from "@/shared/schemas/appearance.ts";
import { emailDarkQuery } from "@/shared/schemas/channel.ts";

const queries: Readonly<Record<Theme, string>> = {
  dark: "@media all",
  light: "@media not all",
  system: emailDarkQuery,
};

export function emailInTheme(html: string, theme: Theme): string {
  return html.replaceAll(emailDarkQuery, queries[theme]);
}
