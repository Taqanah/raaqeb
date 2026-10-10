/**
 * ntfy: one JSON publish to the
 * channel's server, the subject as its title, the plain-text body as its
 * message, the admin link as its click action, each link a view action of
 * the words that open it in place of its line, and a priority by
 * event.
 */
import { ntfyDeclaration } from "@/shared/schemas/channel.ts";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import { jsonHeaders, type NotificationChannel } from "./channel.ts";
import { clip, notificationText, plainText } from "./text.ts";

/** The most UTF-8 bytes ntfy takes in a message and in a title; it refuses more rather than cut it. */
const messageMaxBytes = 4095;
const titleMaxBytes = 1024;

/** ntfy's priorities: high for down and its reminder, the default for the rest. */
const highPriority = 4;
const defaultPriority = 3;

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The monitor's page in the admin area, which a tap on the notification opens; a test has none. */
function clickOf(notification: NotificationPayload): string | undefined {
  return notification.type === "channel.test"
    ? undefined
    : notification.data.monitor.adminUrl;
}

export const ntfyChannel: NotificationChannel = {
  declaration: ntfyDeclaration,
  generate: {},
  send: async (values, payload, transport) => {
    const text = await notificationText(payload);
    const click = clickOf(payload.notification);
    const actions = text.links.map(({ url, words }) => ({
      action: "view",
      label: words,
      url,
    }));
    // ntfy takes a JSON publish only at its root; the server is an origin.
    await transport.post(`${new URL(values.server ?? "").origin}/`, {
      body: JSON.stringify({
        message: clip(
          plainText({ ...text, links: [] }).trimEnd(),
          messageMaxBytes,
          bytes
        ),
        priority:
          payload.notification.type === "monitor.down" ||
          payload.notification.type === "monitor.reminder"
            ? highPriority
            : defaultPriority,
        title: clip(text.subject, titleMaxBytes, bytes),
        topic: values.topic,
        ...(click === undefined ? {} : { click }),
        ...(actions.length === 0 ? {} : { actions }),
      }),
      headers: values.token
        ? { ...jsonHeaders, authorization: `Bearer ${values.token}` }
        : jsonHeaders,
    });
  },
};
