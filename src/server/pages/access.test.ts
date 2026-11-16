import { describe, expect, test } from "bun:test";
import {
  generateInstallKey,
  type InstallKey,
  importInstallKey,
} from "@/server/boot/installkey.ts";
import type { PageAccess } from "@/shared/schemas/page.ts";
import {
  admits,
  createAttemptLimiter,
  type GuardedPage,
  issuePass,
  passCookie,
  passCookieName,
  passLifetimeMs,
  passwordDigest,
  refusedAddress,
  type Visitor,
} from "./access.ts";

const now = Date.UTC(2026, 9, 19, 12);

async function key(): Promise<InstallKey> {
  const imported = await importInstallKey(generateInstallKey());
  if (!imported) {
    throw new Error("no key");
  }
  return imported;
}

function page(
  mode: PageAccess["mode"],
  extra: Partial<PageAccess> = {}
): GuardedPage {
  return {
    access: {
      addresses: [],
      mode,
      passwordDigest:
        mode === "password" ? passwordDigest("hash-1") : undefined,
      ...extra,
    },
    id: "p-1",
  };
}

/** A visitor with nothing: no address, no cookie, no session. */
function stranger(extra: Partial<Visitor> = {}): Visitor {
  return {
    client: undefined,
    cookie: null,
    signedIn: () => Promise.resolve(false),
    ...extra,
  };
}

/** The Cookie header a browser sends back for a Set-Cookie header. */
function cookieOf(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

describe("who a page lets in", () => {
  test("a public page lets in anyone and reads no session", async () => {
    let asked = false;
    expect(
      await admits(
        page("public"),
        stranger({
          signedIn: () => {
            asked = true;
            return Promise.resolve(false);
          },
        }),
        await key(),
        now
      )
    ).toBe(true);
    expect(asked).toBe(false);
  });

  test("a private page lets in nobody without access, whatever its mode", async () => {
    const k = await key();
    for (const mode of ["password", "signed_in", "addresses"] as const) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: one mode at a time
        await admits(
          page(mode, { addresses: ["10.0.0.0/8"] }),
          stranger({ client: "192.0.2.1" }),
          k,
          now
        )
      ).toBe(false);
    }
  });

  test("a signed-in user of this install sees a private page of any mode", async () => {
    const k = await key();
    for (const mode of ["password", "signed_in", "addresses"] as const) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: one mode at a time
        await admits(
          page(mode, { addresses: ["10.0.0.0/8"] }),
          stranger({ signedIn: () => Promise.resolve(true) }),
          k,
          now
        )
      ).toBe(true);
    }
  });

  test("an allowed address lets a visitor in, as an address or a range, in password and addresses mode; the signed-in mode reads none", async () => {
    const k = await key();
    const addresses = ["10.0.0.0/8", "2001:db8::/32", "192.0.2.7"];
    for (const mode of ["password", "addresses"] as const) {
      for (const client of ["10.1.2.3", "2001:db8::1", "192.0.2.7"]) {
        expect(
          // biome-ignore lint/performance/noAwaitInLoops: one client at a time
          await admits(page(mode, { addresses }), stranger({ client }), k, now)
        ).toBe(true);
      }
      expect(
        await admits(
          page(mode, { addresses }),
          stranger({ client: "192.0.2.8" }),
          k,
          now
        )
      ).toBe(false);
    }
    expect(
      await admits(
        page("signed_in", { addresses }),
        stranger({ client: "10.1.2.3" }),
        k,
        now
      )
    ).toBe(false);
  });

  test("a page pass lets its holder into the page it names until it ends", async () => {
    const k = await key();
    const guarded = page("password");
    const value = await issuePass(k, guarded, now);
    const cookie = cookieOf(passCookie(guarded.id, value, false));
    expect(await admits(guarded, stranger({ cookie }), k, now)).toBe(true);
    expect(
      await admits(guarded, stranger({ cookie }), k, now + passLifetimeMs - 1)
    ).toBe(true);
    expect(
      await admits(guarded, stranger({ cookie }), k, now + passLifetimeMs)
    ).toBe(false);
  });

  test("a page pass is found among the other cookies a browser sends", async () => {
    const k = await key();
    const guarded = page("password");
    const value = await issuePass(k, guarded, now);
    const cookie = `theme=dark; ${cookieOf(passCookie(guarded.id, value, false))}; raaqeb.session_token=abc`;
    expect(await admits(guarded, stranger({ cookie }), k, now)).toBe(true);
  });

  test("a new page password ends every pass the old one earned", async () => {
    const k = await key();
    const before = page("password");
    const value = await issuePass(k, before, now);
    const cookie = cookieOf(passCookie(before.id, value, false));
    const after = page("password", {
      passwordDigest: passwordDigest("hash-2"),
    });
    expect(await admits(after, stranger({ cookie }), k, now)).toBe(false);
  });

  test("a page pass opens no other page, no page out of password mode, and none under another install key", async () => {
    const k = await key();
    const guarded = page("password");
    const value = await issuePass(k, guarded, now);
    const other = { ...guarded, id: "p-2" };
    // The pass carried under the other page's name, as a visitor could copy it.
    expect(
      await admits(
        other,
        stranger({ cookie: cookieOf(passCookie(other.id, value, false)) }),
        k,
        now
      )
    ).toBe(false);
    const cookie = cookieOf(passCookie(guarded.id, value, false));
    expect(await admits(page("signed_in"), stranger({ cookie }), k, now)).toBe(
      false
    );
    expect(await admits(guarded, stranger({ cookie }), await key(), now)).toBe(
      false
    );
  });

  test("a forged or damaged page pass is no pass", async () => {
    const k = await key();
    const guarded = page("password");
    const value = await issuePass(k, guarded, now);
    const name = passCookieName(guarded.id);
    for (const forged of [
      "",
      "1.",
      "not-a-pass",
      `${value.slice(0, -2)}AA`,
      `1.${btoa(`${guarded.id}.${guarded.access.passwordDigest}.${now + passLifetimeMs}`)}`,
    ]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: one forgery at a time
        await admits(guarded, stranger({ cookie: `${name}=${forged}` }), k, now)
      ).toBe(false);
    }
  });
});

describe("the page pass cookie", () => {
  test("is HttpOnly, SameSite=Lax, for the whole host, lives as long as the pass, and is Secure over https alone", () => {
    const plain = passCookie("p-1", "v", false);
    const secure = passCookie("p-1", "v", true);
    for (const header of [plain, secure]) {
      expect(header.startsWith(`${passCookieName("p-1")}=v;`)).toBe(true);
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Lax");
      expect(header).toContain("Path=/");
      expect(header).toContain(`Max-Age=${passLifetimeMs / 1000};`);
    }
    expect(plain).not.toContain("Secure");
    expect(secure).toContain("Secure");
  });

  test("each page's pass has a cookie of its own", () => {
    expect(passCookieName("p-1")).not.toBe(passCookieName("p-2"));
  });
});

describe("the allowed addresses", () => {
  test("an IP address or a CIDR range is allowed, anything else is named", () => {
    expect(
      refusedAddress(["10.0.0.1", "10.0.0.0/8", "2001:db8::/32", "::1"])
    ).toBeUndefined();
    expect(refusedAddress(["10.0.0.0/8", "office", "::1"])).toBe("office");
    expect(refusedAddress(["10.0.0.0/33"])).toBe("10.0.0.0/33");
  });
});

describe("attempts at a page password", () => {
  test("each client network has its share in a period, and the next period another", () => {
    const limiter = createAttemptLimiter(2, 1000, 100);
    expect(limiter.take("192.0.2.1", 0)).toBe(true);
    expect(limiter.take("192.0.2.1", 1)).toBe(true);
    expect(limiter.take("192.0.2.1", 2)).toBe(false);
    expect(limiter.take("192.0.2.2", 2)).toBe(true);
    expect(limiter.take("192.0.2.1", 1001)).toBe(true);
  });

  test("an IPv6 site's whole /48 shares one share, so its many /64s cannot each try; an IPv4 address has its own", () => {
    const limiter = createAttemptLimiter(1, 1000, 100);
    expect(limiter.take("2001:db8::1", 0)).toBe(true);
    expect(limiter.take("2001:db8:0:1::1", 0)).toBe(false);
    expect(limiter.take("2001:db8:0:ffff::1", 0)).toBe(false);
    expect(limiter.take("2001:db8:1::1", 0)).toBe(true);
    expect(limiter.take("192.0.2.1", 0)).toBe(true);
    expect(limiter.take("192.0.2.2", 0)).toBe(true);
  });

  test("a full table forgets the client that tried longest ago, so a flood of new clients never locks out a new visitor", () => {
    const limiter = createAttemptLimiter(1, 1000, 3);
    for (const client of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      expect(limiter.take(client, 0)).toBe(true);
    }
    expect(limiter.take("192.0.2.4", 10)).toBe(true);
    // The one forgotten was the oldest; the others still hold their tries.
    expect(limiter.take("192.0.2.1", 10)).toBe(true);
    expect(limiter.take("192.0.2.3", 10)).toBe(false);
  });

  test("the client forgotten is the one that tried longest ago, not the one first seen", () => {
    const limiter = createAttemptLimiter(2, 1000, 3);
    expect(limiter.take("192.0.2.1", 0)).toBe(true);
    expect(limiter.take("192.0.2.2", 1)).toBe(true);
    expect(limiter.take("192.0.2.3", 2)).toBe(true);
    // The first client tries again, so the second is now the one that tried longest ago.
    expect(limiter.take("192.0.2.1", 3)).toBe(true);
    expect(limiter.take("192.0.2.4", 4)).toBe(true);
    expect(limiter.take("192.0.2.1", 5)).toBe(false);
  });

  test("a refunded try, the right password's, leaves the client its share", () => {
    const limiter = createAttemptLimiter(2, 1000, 100);
    expect(limiter.take("192.0.2.1", 0)).toBe(true);
    limiter.refund("192.0.2.1", 0);
    expect(limiter.take("192.0.2.1", 1)).toBe(true);
    expect(limiter.take("192.0.2.1", 2)).toBe(true);
    expect(limiter.take("192.0.2.1", 3)).toBe(false);
  });

  test("a client past its share waits until its oldest try leaves the period, and one with room waits for nothing", () => {
    const limiter = createAttemptLimiter(2, 1000, 100);
    expect(limiter.retryAfter("192.0.2.1", 0)).toBe(0);
    limiter.take("192.0.2.1", 100);
    limiter.take("192.0.2.1", 400);
    expect(limiter.retryAfter("192.0.2.1", 500)).toBe(600);
    expect(limiter.retryAfter("192.0.2.1", 1100)).toBe(0);
  });

  test("the wait it names is exact: one millisecond short is still refused, and the moment it ends takes the try", () => {
    const limiter = createAttemptLimiter(1, 1000, 100);
    limiter.take("192.0.2.1", 0);
    expect(limiter.retryAfter("192.0.2.1", 400)).toBe(600);
    expect(limiter.take("192.0.2.1", 999)).toBe(false);
    expect(limiter.take("192.0.2.1", 1000)).toBe(true);
  });
});
