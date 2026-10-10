import { describe, expect, test } from "bun:test";
import type { ChannelChoice } from "@/shared/schemas/channel.ts";
import { type Monitor, tagMaxLength } from "@/shared/schemas/monitor.ts";
import { changeOf, removable } from "./bulk-change.tsx";

const monitor = (
  channels: string[],
  tags: string[]
): Pick<Monitor, "channels" | "tags"> => ({ channels, tags });

const channel = (id: string): ChannelChoice => ({
  appliesToNew: false,
  id,
  name: id,
  type: "webhook",
});

describe("the selection bar's dialog", () => {
  test("a typed tag is posted trimmed; an empty one is required, a long one too long, and one with a Latin or an Arabic comma is one tag too many", () => {
    expect(changeOf("add_tag", " on-call ")).toEqual({
      kind: "add_tag",
      tag: "on-call",
    });
    expect(changeOf("add_tag", "  ")).toEqual({ id: "monitor_error_required" });
    expect(changeOf("add_tag", "x".repeat(tagMaxLength + 1))).toEqual({
      id: "monitor_error_too_long",
      values: { max: tagMaxLength },
    });
    for (const typed of ["a, b", "أ، ب"]) {
      expect(changeOf("add_tag", typed)).toEqual({
        id: "monitor_bulk_tag_comma",
      });
    }
  });

  test("an empty group takes the monitors out of theirs; a typed one is posted trimmed", () => {
    expect(changeOf("set_group", " ")).toEqual({
      group: undefined,
      kind: "set_group",
    });
    expect(changeOf("set_group", " Staging ")).toEqual({
      group: "Staging",
      kind: "set_group",
    });
  });

  test("a channel change with no channel chosen is required", () => {
    expect(changeOf("add_channel", "")).toEqual({
      id: "monitor_error_required",
    });
    expect(changeOf("remove_channel", "c1")).toEqual({
      channel: "c1",
      kind: "remove_channel",
    });
  });

  test("a removal offers only the channels and the tags at least one selected monitor has, tags in code point order", () => {
    const offered = removable(
      [monitor(["c2"], ["web", "api"]), monitor([], ["api", "db"])],
      [channel("c1"), channel("c2"), channel("c3")]
    );
    expect(offered.channels.map((each) => each.id)).toEqual(["c2"]);
    expect(offered.tags).toEqual(["api", "db", "web"]);
  });
});
