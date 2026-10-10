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
    expect(html).toContain("29 ربيع الأول 1448 هـ، 9:49 ص (غرينتش+3)");
  });
});
