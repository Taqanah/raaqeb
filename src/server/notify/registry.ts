/**
 * Every channel type Raaqeb ships, by its type. Channels are
 * compiled in: adding one is a declaration in
 * shared/schemas/channel.ts, a file here beside the others, and one entry
 * below.
 */
import type { ChannelType } from "@/shared/schemas/channel.ts";
import type { NotificationChannel } from "./channel.ts";
import { discordChannel } from "./discord.ts";
import { emailChannel } from "./email.ts";
import { ntfyChannel } from "./ntfy.ts";
import { pagerdutyChannel } from "./pagerduty.ts";
import { slackChannel } from "./slack.ts";
import { teamsChannel } from "./teams.ts";
import { telegramChannel } from "./telegram.ts";
import { webhookChannel } from "./webhook.ts";

export const notificationChannels: Readonly<
  Record<ChannelType, NotificationChannel>
> = {
  discord: discordChannel,
  email: emailChannel,
  ntfy: ntfyChannel,
  pagerduty: pagerdutyChannel,
  slack: slackChannel,
  teams: teamsChannel,
  telegram: telegramChannel,
  webhook: webhookChannel,
};
