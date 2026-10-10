import { expect, test } from "bun:test";
import { channelTypes } from "@/shared/schemas/channel.ts";
import { notificationChannels } from "./registry.ts";

test("every channel type sends through its own channel", () => {
  for (const type of channelTypes) {
    expect(notificationChannels[type].declaration.type).toBe(type);
  }
});
