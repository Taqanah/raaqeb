import { describe, expect, test } from "bun:test";
import { isCronExpression } from "./cron.ts";

const accepted = [
  "* * * * *",
  "*/15 * * * *",
  "0 9 * * MON-FRI",
  "0 9 * * Monday-Friday",
  "0 0 1 JAN,JUN *",
  "30 2 * * mon",
  "0 3 * * sUn",
  "0 0 1 january *",
  "0 0 * Sep *",
  "5/10 * * * *",
  "1-5/2 * * * *",
  "*/5,10 * * * *",
  "0 0 * * 0-7",
  "0 0 * * 5-7",
  "0 0 */2 * *",
  "0 0 1 1-12/3 *",
  "07 * * * *",
  "0  9  *  *  1,3,5",
  "@daily",
  "@Hourly",
  "@annually",
  "@midnight",
  "@weekly",
  "@monthly",
  "@yearly",
  "*/127 * * * *",
  "0 0 29 2 *",
  // Day 30 or a Monday: the day-of-week field keeps it firing.
  "0 0 30 2 1",
  "0 0 31 */2 *",
];

const refused = [
  "",
  "* * * *",
  "* * * * * *",
  "60 * * * *",
  "* 24 * * *",
  "* * 0 * *",
  "* * 32 * *",
  "* * * 13 *",
  "* * * * 8",
  "a * * * *",
  "*/0 * * * *",
  "5-1 * * * *",
  "* * * * sat-sun",
  "* * * * fri-mon",
  "mon * * * *",
  "? * * * *",
  "* * L * *",
  "-1 * * * *",
  "1- * * * *",
  "1-2-3 * * * *",
  "*/5/2 * * * *",
  "1,,2 * * * *",
  "1.0 * * * *",
  "* * * * tues",
  "* * * * THURS",
  "* * * sept *",
  "@reboot",
  "@every 5m",
  // Bun's steps stop at 127, and a no-break space is no field separator to Bun.
  "*/128 * * * *",
  "0 */200 * * *",
  "0 3\u00a0* * *",
  // Parses and never fires: no month has such a day and the weekday field does not add one.
  "0 0 30 2 *",
  "0 0 31 4 *",
  "0 0 30 feb *",
  "0 0 31 2,4,6 *",
];

/** Whether Bun's parser finds a fire time: it throws on what it cannot read and answers null for what never fires. */
function bunFires(text: string): boolean {
  try {
    return Bun.cron.parse(text, Date.UTC(2026, 0, 1), { tz: "UTC" }) !== null;
  } catch {
    return false;
  }
}

describe("a heartbeat monitor's cron expression", () => {
  test("accepts five fields or a nickname as Bun reads them: names, ranges, lists and steps", () => {
    expect(accepted.filter((text) => !isCronExpression(text))).toEqual([]);
  });

  test("refuses a wrong field count, a value outside its field, a reversed range, a zero step and a name Bun does not know", () => {
    expect(refused.filter((text) => isCronExpression(text))).toEqual([]);
  });

  test("never accepts an expression Bun's parser refuses or that never fires, so the form's refusal is the server's", () => {
    expect(
      [...accepted, ...refused].filter(
        (text) => isCronExpression(text) && !bunFires(text)
      )
    ).toEqual([]);
  });

  test("every refused expression the corpus names is refused by Bun too, or never fires there, so the grammar is not stricter than it says", () => {
    expect(refused.filter(bunFires)).toEqual([]);
  });

  test("every step from 1 to 200 in every field agrees with Bun wherever the grammar accepts it", () => {
    const disagreements: string[] = [];
    for (let field = 0; field < 5; field += 1) {
      for (let step = 1; step <= 200; step += 1) {
        const parts = ["0", "0", "1", "1", "*"];
        parts[field] = `*/${step}`;
        const text = parts.join(" ");
        if (isCronExpression(text) && !bunFires(text)) {
          disagreements.push(text);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});
