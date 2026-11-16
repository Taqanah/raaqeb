import { describe, expect, test } from "bun:test";
import { whoisAnswerOf, whoisExpiry, whoisServerOf } from "./whois.ts";

/** A registry's answer as captured on 2026-10-18, with contact values replaced by REDACTED. */
const captured = (name: string): Promise<string> =>
  Bun.file(`${import.meta.dir}/fixtures/whois/${name}.txt`).text();

describe("the WHOIS server IANA names for a TLD", () => {
  test("a TLD with one is named on its whois line", async () => {
    expect(whoisServerOf(await captured("iana-ae"))).toEqual({
      server: "whois.aeda.net.ae",
    });
    expect(whoisServerOf(await captured("iana-qa"))).toEqual({
      server: "whois.registry.qa",
    });
  });

  test("a TLD whose whois line is empty has none", async () => {
    expect(whoisServerOf(await captured("iana-eg"))).toEqual({
      server: undefined,
    });
  });

  test("an answer that is not IANA's record of a TLD, a rate limit or an empty reply, is no answer", () => {
    expect(
      whoisServerOf("% Too many queries from your address; try again later.\n")
    ).toBeUndefined();
    expect(whoisServerOf("")).toBeUndefined();
  });
});

describe("what a registry's WHOIS answer says of the name asked", () => {
  test.each([
    ["google.co.ma", "google.co.ma", Date.UTC(2027, 0, 29)],
    ["sa-registered", "google.com.sa", undefined],
    ["google.dz", "google.dz", undefined],
    ["google.tn", "google.tn", undefined],
    ["www.google.de", "google.de", undefined],
  ])("%s is a record of %s", async (name, domain, expiresAt) => {
    expect(whoisAnswerOf(await captured(name))).toEqual({
      domain,
      expiresAt,
      held: true,
    });
  });

  test.each([
    "mx-not-held",
    "sa-not-held",
    "com.qa",
    "www.google.co.ma",
    "www.google.tn",
  ])("%s says the registry holds no such name", async (name) => {
    expect(whoisAnswerOf(await captured(name))).toEqual({ held: false });
  });

  test.each([
    "",
    "% Query rate limit exceeded. Please wait 60 seconds.\n",
    "Server busy, try again later\r\n",
    "Terms of use: queries are logged.\n",
  ])("“%s”, neither a record nor a not-found, is no answer", (answer) => {
    expect(whoisAnswerOf(answer)).toBeUndefined();
  });
});

describe("the expiry a registry's WHOIS answer gives", () => {
  test.each([
    ["google.co.ma", Date.UTC(2027, 0, 29)],
    ["google.so", Date.UTC(2027, 0, 24)],
    ["google.io", Date.UTC(2027, 8, 30, 1)],
    ["google.co", Date.UTC(2027, 1, 24, 23, 59, 59)],
  ])("%s gives its registry expiry date", async (name, expiresAt) => {
    expect(whoisExpiry(await captured(name))).toEqual({
      expiresAt,
      listed: true,
    });
  });

  test("an expiry line whose value is no date gives an unknown date", async () => {
    // .dz answers "Expiry Date:    N/A".
    expect(whoisExpiry(await captured("google.dz"))).toEqual({
      expiresAt: undefined,
      listed: true,
    });
  });

  test.each([
    ["sa-registered", "from a registry that publishes no expiry"],
    ["sa-not-held", "a name the registry does not hold"],
  ])("%s, %s, lists none", async (name) => {
    expect(whoisExpiry(await captured(name))).toEqual({ listed: false });
  });

  test("the first expiry line counts, as the registry's comes before the registrar's", () => {
    const answer =
      "Registry Expiry Date: 2027-03-04T00:00:00Z\nRegistrar Registration Expiration Date: 2028-01-01T00:00:00Z\n";
    expect(whoisExpiry(answer)).toEqual({
      expiresAt: Date.UTC(2027, 2, 4),
      listed: true,
    });
  });

  test.each([
    ["Expiration Date: 2027.03.04", Date.UTC(2027, 2, 4)],
    ["Expiration Date: 2027/03/04", Date.UTC(2027, 2, 4)],
    ["expires: 20270304", Date.UTC(2027, 2, 4)],
    ["paid-till: 2027-03-04T21:00:00Z", Date.UTC(2027, 2, 4, 21)],
    ["Expiry date: 04-Mar-2027", Date.UTC(2027, 2, 4)],
    ["Expires On: 4 March 2027", Date.UTC(2027, 2, 4)],
    ["Expiry Date: 2027-03-04 12:00:00 +03:00", Date.UTC(2027, 2, 4, 9)],
    ["Expiry Date: 2027-03-04 12:00:00 +05:30", Date.UTC(2027, 2, 4, 6, 30)],
    ["Expiry Date.......: 2027-03-04", Date.UTC(2027, 2, 4)],
  ])("“%s” reads one way only", (line, expiresAt) => {
    expect(whoisExpiry(`${line}\r\n`)).toEqual({ expiresAt, listed: true });
  });

  test("a date followed by a zone or words it cannot read is an unknown date", () => {
    expect(whoisExpiry("Expiry Date: 2027-03-04 12:00:00 (UTC+3)")).toEqual({
      expiresAt: undefined,
      listed: true,
    });
  });

  test.each([
    "Expiration Date: 04/03/2027",
    "Expiration Date: 04.03.2027",
    "Expiration Date: 04-03-2027",
  ])(
    "“%s”, day and month in an order it does not say, is an unknown date",
    (line) => {
      expect(whoisExpiry(line)).toEqual({ expiresAt: undefined, listed: true });
    }
  );

  test("a date that is not on the calendar is an unknown date", () => {
    expect(whoisExpiry("Registry Expiry Date: 2027-02-30")).toEqual({
      expiresAt: undefined,
      listed: true,
    });
  });

  test.each([
    "Registry Expiry Date: 2027-03-00",
    "Registry Expiry Date: 2027-13-01",
    "Registry Expiry Date: 2027-03-04T24:00:00Z",
    "Registry Expiry Date: 2027-03-04T12:60:00Z",
    "Expiry date: 04-Smarch-2027",
  ])("“%s”, no day there is, is an unknown date", (line) => {
    expect(whoisExpiry(line)).toEqual({ expiresAt: undefined, listed: true });
  });

  test("a zone behind UTC moves the instant later", () => {
    expect(whoisExpiry("Expiry Date: 2027-03-04 21:00:00 -05:00")).toEqual({
      expiresAt: Date.UTC(2027, 2, 5, 2),
      listed: true,
    });
  });

  test("a comment line that mentions expiry lists none", () => {
    expect(
      whoisExpiry("% Expiration Date: 2027-03-04\n# expires: 2027-03-04\n")
    ).toEqual({ listed: false });
  });
});
