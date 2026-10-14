import { describe, expect, test } from "bun:test";
import { render } from "./fixture.tsx";
import { When } from "./when.tsx";

describe("a time on a status page", () => {
  test("is written in the install's calendar on the server's first paint", () => {
    const html = render(
      "ar",
      <When
        at="2026-09-11T06:49:00.000Z"
        time={{
          calendar: "hijri",
          clock: "12h",
          timeZone: "Asia/Riyadh",
          visitor: undefined,
        }}
      />
    );
    // The time and zone are held together by no-break spaces, read here as spaces.
    expect(html.replaceAll("\u00A0", " ")).toContain(
      "29 ربيع الأول 1448 هـ، 9:49 ص (غرينتش+3)"
    );
  });

  test("holds its time and zone on one line, however narrow the screen", () => {
    const html = render(
      "ar",
      <When
        at="2026-09-11T06:49:00.000Z"
        time={{
          calendar: "hijri_gregorian",
          clock: "12h",
          timeZone: "Asia/Riyadh",
          visitor: undefined,
        }}
      />
    );
    const shown = html.slice(html.indexOf(">") + 1, html.lastIndexOf("<"));
    const tail = shown.split("، ").at(-1) ?? "";
    expect(tail).toContain("9:49");
    expect(tail).toContain("(غرينتش+3)");
    // Only a no-break space may join the time to its zone.
    expect(tail).not.toContain(" ");
  });
});
