/**
 * The time now in the zone, clock and calendar a form has chosen, under its zone
 * field, so a change shows at once what it will do.
 * The clock is read after mount and each half minute, so the server's
 * render and the browser's agree.
 */
import { type ReactNode, useEffect, useState } from "react";
import { formatDateTimeWithZone } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Calendar, Clock } from "@/shared/schemas/clock.ts";
import { FieldDescription } from "@/shared/ui/field.tsx";

const tickMs = 30_000;

export function TimeNow({
  calendar,
  clock,
  timeZone,
}: {
  readonly calendar: Calendar;
  readonly clock: Clock;
  readonly timeZone: string;
}): ReactNode {
  const { locale, t } = useMessages();
  const [now, setNow] = useState<number | undefined>();
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, []);
  return (
    <FieldDescription className="min-h-5 tabular-nums" data-slot="time-now">
      {now === undefined
        ? null
        : t("setting_time_now", {
            time: formatDateTimeWithZone(locale, now, {
              calendar,
              clock,
              timeZone,
            }),
          })}
    </FieldDescription>
  );
}
