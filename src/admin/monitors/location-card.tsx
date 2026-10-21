/**
 * The monitor page's locations (CONTEXT.md "Location"): for a monitor
 * checked from more than one, each location's state, response time and when
 * its check started, and the confirmation rule that turns them into an
 * outage. A location with no fresh result is unknown, never down.
 */
import type { ReactNode } from "react";
import {
  formatDateTimeWithZone,
  formatWhen,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import type { LocationState } from "@/shared/schemas/probe.ts";
import { Badge } from "@/shared/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { formatResponseTime, resultWords } from "./check-parts.tsx";

export function LocationsCard({
  clock,
  locations,
  monitor,
  now,
}: {
  readonly clock: TimeOptions;
  readonly locations: readonly LocationState[];
  readonly monitor: Monitor;
  readonly now: number;
}): ReactNode {
  const { locale, t } = useMessages();
  const total = locations.length;
  return (
    <Card data-slot="locations">
      <CardHeader divided>
        <CardTitle>{t("monitor_detail_locations")}</CardTitle>
        <CardDescription>
          {t("monitor_detail_locations_rule", {
            count: Math.min(monitor.confirmations ?? 1, total),
            total,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {locations.map((state) => (
            <li
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              data-location={state.location}
              data-result={state.result ?? "unknown"}
              key={state.location}
            >
              <span className="flex min-w-0 items-center gap-3">
                <bdi className="truncate font-medium text-sm">
                  {state.name ?? t("monitor_location_main")}
                </bdi>
                {state.result ? (
                  <Badge variant={state.result}>
                    {t(resultWords[state.result])}
                  </Badge>
                ) : (
                  <Badge variant="secondary">
                    {t("monitor_location_unknown")}
                  </Badge>
                )}
              </span>
              <span className="flex items-center gap-4 text-muted-foreground text-sm tabular-nums">
                {state.responseMs === undefined ? null : (
                  <span>{formatResponseTime(locale, state.responseMs)}</span>
                )}
                {state.startedAt === undefined ? (
                  <span>{t("monitor_location_never")}</span>
                ) : (
                  <time
                    dateTime={new Date(state.startedAt).toISOString()}
                    title={formatDateTimeWithZone(
                      locale,
                      state.startedAt,
                      clock
                    )}
                  >
                    {t("monitor_location_checked", {
                      when: formatWhen(locale, state.startedAt, {
                        ...clock,
                        now,
                      }),
                    })}
                  </time>
                )}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
