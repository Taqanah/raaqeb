/**
 * The clock format as a segmented control: each
 * option shows the same afternoon time in its format, so the difference is
 * seen before it is chosen. The account page adds "as the install", which
 * names the format it follows.
 */
import type { ReactNode } from "react";
import { formatChartTick } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { type Clock, clocks } from "@/shared/schemas/clock.ts";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";

/** A fixed afternoon time, 3:45 PM, so each option's sample is the same moment and renders alike on the server and in the browser. */
const sampleTime = Date.UTC(2026, 0, 1, 15, 45);

export function ClockChoice({
  defaultValue,
  follow,
  labelledBy,
  name,
  onClock,
}: {
  readonly defaultValue: string;
  /** "As the install", with the value it stands for; only the account page offers it. */
  readonly follow?: { readonly clock: Clock; readonly value: string };
  readonly labelledBy: string;
  readonly name: string;
  readonly onClock?: (value: unknown) => void;
}): ReactNode {
  const { locale, t } = useMessages();
  const sample = (clock: Clock) =>
    formatChartTick(locale, sampleTime, "minute", {
      // A time alone reads the same in every calendar.
      calendar: "gregorian",
      clock,
      timeZone: "UTC",
    });
  return (
    <Segmented
      aria-labelledby={labelledBy}
      data-name={name}
      defaultValue={defaultValue}
      name={name}
      onValueChange={onClock}
    >
      {follow ? (
        <SegmentedItem hint={sample(follow.clock)} value={follow.value}>
          {t("setting_follow_install")}
        </SegmentedItem>
      ) : null}
      {clocks.map((clock) => (
        <SegmentedItem hint={sample(clock)} key={clock} value={clock}>
          {t(`setting_clock_${clock}`)}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}
