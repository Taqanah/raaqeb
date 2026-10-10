/**
 * A component's day bar on a status page (CONTEXT.md "Day bar"): the shared bar with the page's status names, its day card linking
 * each incident and maintenance window to its view and, at its foot, the
 * history of the UTC month the day belongs to. Today's cell is live,
 * up to the memo's five-minute refresh.
 */
import { type ReactNode, useCallback } from "react";
import { monthOf } from "@/shared/domain/history.ts";
import type { StatusNames } from "@/shared/domain/status.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Calendar } from "@/shared/schemas/clock.ts";
import type {
  OverviewDay,
  OverviewNotice,
  PublicView,
} from "@/shared/schemas/overview.ts";
import { UptimeBar as Bar, type NoticeKind } from "@/shared/ui/uptime-bar.tsx";
import { quietLink, ViewLink } from "./link.tsx";
import { Prose } from "./prose.tsx";

export function UptimeBar({
  calendar,
  days,
  labels,
  percentages,
  view,
}: {
  /** The install's calendar, from the page's document. */
  readonly calendar: Calendar;
  readonly days: readonly OverviewDay[];
  /** The page's own names for the status levels in this locale. */
  readonly labels: StatusNames;
  /** Whether the page shows uptime figures. */
  readonly percentages: boolean;
  readonly view: PublicView;
}): ReactNode {
  const { t } = useMessages();
  const notice = useCallback(
    (kind: NoticeKind, each: OverviewNotice) => (
      <ViewLink
        className={quietLink}
        slot={kind === "incidents" ? "day-incident" : "day-maintenance"}
        suffix={`/${kind}/${encodeURIComponent(each.id)}`}
        view={view}
      >
        <Prose content={each.title} />
      </ViewLink>
    ),
    [view]
  );
  const footer = useCallback(
    (day: OverviewDay) => (
      <ViewLink
        className={quietLink}
        slot="day-month"
        suffix={`/history/${monthOf(Date.parse(day.date))}`}
        view={view}
      >
        {t("public_day_month")}
      </ViewLink>
    ),
    [t, view]
  );
  return (
    <Bar
      // The row gives the uptime beside the name, so the bar has no caption.
      calendar={calendar}
      caption={false}
      className="[&>button]:h-6"
      days={days}
      footer={footer}
      labels={labels}
      notice={notice}
      percentages={percentages}
    />
  );
}
