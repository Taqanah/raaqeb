import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { day, linesOf, targetInstall } from "@/server/export/fixture.ts";
import { importInstall } from "@/server/export/import.ts";
import { channelTypes } from "@/shared/schemas/channel.ts";
import { checkTypes } from "@/shared/schemas/monitor.ts";
import { seedFile } from "./upgrade-check-seed.ts";

const now = Date.UTC(2027, 3, 14, 9, 30);

const headerSchema = z.object({
  configuration: z.record(
    z.string(),
    z.array(z.record(z.string(), z.unknown()))
  ),
});

/** The seed, built once, with its history and the header's tables. */
let built: ReturnType<typeof build> | undefined;
const seeded = () => {
  built ??= build();
  return built;
};

async function build() {
  const file = await seedFile(now);
  const lines = await linesOf(new Blob([file]).stream());
  return {
    configuration: headerSchema.parse(lines[0]).configuration,
    file,
    history: lines.slice(1),
  };
}

const target = await targetInstall();
afterAll(() => target.cleanup());

describe("the install the old version is filled with", () => {
  test("it holds a monitor of every check type", async () => {
    const { configuration } = await seeded();
    expect(
      new Set(configuration.monitors?.map((row) => row.checkType))
    ).toEqual(new Set(checkTypes));
  });

  test("it holds a channel of every kind", async () => {
    const { configuration } = await seeded();
    expect(new Set(configuration.channels?.map((row) => row.type))).toEqual(
      new Set(channelTypes)
    );
  });

  test("every monitor is paused, so no check runs between the two exports", async () => {
    const { configuration } = await seeded();
    expect(configuration.monitors?.every((row) => row.paused === true)).toBe(
      true
    );
  });

  test("it holds status pages with components, an incident with updates, a maintenance window, subscribers and settings", async () => {
    const { configuration } = await seeded();
    for (const table of [
      "statusPages",
      "components",
      "incidents",
      "incidentUpdates",
      "maintenanceWindows",
      "subscriptions",
      "settings",
    ]) {
      expect(configuration[table]?.length).toBeGreaterThan(0);
    }
  });

  test("it holds history of every kind, outages open and ended among them", async () => {
    const { history } = await seeded();
    for (const kind of ["check", "hourly", "daily", "outage"]) {
      expect(history.some((line) => line.kind === kind)).toBe(true);
    }
    const outages = history.filter((line) => line.kind === "outage");
    expect(outages.some((line) => line.endedAt === null)).toBe(true);
    expect(outages.some((line) => line.endedAt !== null)).toBe(true);
  });

  test("its newest history ends at the present, within a day", async () => {
    const { history } = await seeded();
    const newest = Math.max(
      ...history
        .flatMap((line) => [line.at, line.startedAt])
        .filter((moment) => typeof moment === "string")
        .map((moment) => Date.parse(moment))
    );
    expect(newest).toBeLessThanOrEqual(now);
    expect(newest).toBeGreaterThan(now - 2 * day);
  });

  test("an empty install restores it, every monitor with it", async () => {
    const { configuration, file } = await seeded();
    const answer = await importInstall(
      target.storage,
      target.key,
      new Blob([file]).stream(),
      now
    );
    expect(answer).toMatchObject({
      monitors: configuration.monitors?.length,
      ok: true,
    });
  });
});

describe("the install for an old version that lacks a check type or a channel kind", () => {
  test("it leaves out what it is told the old version lacks and keeps the rest", async () => {
    const lines = await linesOf(
      new Blob([await seedFile(now, ["docker", "ntfy"])]).stream()
    );
    const { configuration } = headerSchema.parse(lines[0]);
    expect(
      new Set(configuration.monitors?.map((row) => row.checkType))
    ).toEqual(new Set(checkTypes.filter((type) => type !== "docker")));
    expect(new Set(configuration.channels?.map((row) => row.type))).toEqual(
      new Set(channelTypes.filter((type) => type !== "ntfy"))
    );
  });
});
