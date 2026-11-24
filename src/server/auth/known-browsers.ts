/**
 * Known browsers (CONTEXT.md "Known browser"), OWASP's device cookie: a
 * browser that signed in to an account here, or opened a valid reset link,
 * carries a cookie sealed with the install key that names the account by its
 * id, which no later account reuses. At the entry its sign-ins have an
 * allowance besides their network's, one per account however many cookies
 * signing in has given out, and go first when sign-in is busy; ten wrong
 * passwords from browsers known for an account in a quarter of an hour and
 * they count as strangers' again. A try at an account from a
 * browser not known for that account counts against the account's ten in a
 * quarter of an hour and waits for one of the install's few password checks
 * a second, refused before any hash: guessing spread over many networks
 * gains nothing, and the checks keep their CPU. Every count is in memory, on
 * one process, and a restart clears it.
 */
import { decrypt, encrypt, type InstallKey } from "@/server/boot/installkey.ts";
import { createRates, type Rate } from "@/server/rates.ts";

/** The cookie's name; it is sent only to Better Auth's addresses. */
export const knownBrowserCookieName = "raaqeb.known";

/** How long the cookie lasts, the most a browser keeps one; each sign-in renews it. */
const lifetimeMs = 400 * 24 * 60 * 60 * 1000;

/** How the cookie is set: HttpOnly, SameSite=Lax, sent only to Better Auth's addresses, for as long as a browser keeps one; Secure over https is the caller's. */
export const knownBrowserCookieOptions = {
  httpOnly: true,
  maxAge: lifetimeMs / 1000,
  path: "/api/auth",
  sameSite: "lax",
} as const;

/** Ten in a quarter of an hour: a bucket of ten that gains one every 90 seconds. */
const tenAQuarterHour: Rate = { capacity: 10, everyMs: 90_000 };

/** The install's password checks for browsers not known for the account: about five a second, a few percent of one core at the floor's hash time. */
const hashes: Rate = { capacity: 5, everyMs: 200 };

/** What a known browser's cookie names: the account's id. */
export interface KnownBrowser {
  readonly account: string;
}

/** The counts behind known browsers and password tries. */
export interface KnownBrowsers {
  /** The Set-Cookie header that makes this browser known for the account with this id, Secure over https. */
  readonly cookie: (
    key: InstallKey,
    account: string,
    secure: boolean
  ) => Promise<string>;
  /** Counts a wrong password typed in a known browser for its own account. */
  readonly countWrong: (browser: KnownBrowser) => void;
  /** The seconds a password try at the account with this email must wait, from a browser not known for it, before any hash: past the account's ten in a quarter of an hour or the install's password checks a second; 0 when it may go, and then it is counted. An address with no account counts the same, so the answer tells nothing of who has one. */
  readonly guessWait: (email: string) => number;
  /** The known browser a request's cookie names: sealed with this key, not yet ended, and not past its wrong passwords; nothing otherwise. */
  readonly read: (
    key: InstallKey,
    cookie: string | null
  ) => Promise<KnownBrowser | undefined>;
  /** The cookie's value for the account with this id, sealed with the key. */
  readonly seal: (key: InstallKey, account: string) => Promise<string>;
  /** How many counts are held. */
  readonly size: () => number;
}

/** Known browsers over a clock in milliseconds; past 10,000 accounts typed, the new ones share one ten. */
export function createKnownBrowsers(
  now: () => number = Date.now
): KnownBrowsers {
  const counts = createRates(10_000, now);
  const seal = (key: InstallKey, account: string) =>
    encrypt(key, `${account} ${now() + lifetimeMs}`);
  return {
    cookie: async (key, account, secure) =>
      `${knownBrowserCookieName}=${await seal(key, account)}; Path=${knownBrowserCookieOptions.path}; Max-Age=${knownBrowserCookieOptions.maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
    countWrong: (browser) => {
      counts.take("known wrong", tenAQuarterHour, browser.account);
    },
    guessWait: (email) => {
      const typed = email.toLowerCase();
      // Both are looked at first, so a try one of them refuses spends nothing of the other.
      const wait = Math.max(
        counts.waits("guesses", tenAQuarterHour, typed),
        counts.waits("hashes", hashes, "install")
      );
      if (wait === 0) {
        counts.take("guesses", tenAQuarterHour, typed);
        counts.take("hashes", hashes, "install");
      }
      return wait;
    },
    seal,
    size: counts.size,
    read: async (key, cookie) => {
      const value = new Bun.CookieMap(cookie ?? "").get(knownBrowserCookieName);
      if (!value) {
        return;
      }
      const [account, ends] = (await decrypt(key, value))?.split(" ") ?? [];
      if (
        account &&
        Number(ends) > now() &&
        counts.waits("known wrong", tenAQuarterHour, account) === 0
      ) {
        return { account };
      }
    },
  };
}

// One set of counts per open storage, which the entry and that storage's auth instance share; onboarding's new storage starts afresh.
const perStorage = new WeakMap<object, KnownBrowsers>();

/** The counts over this storage. */
export function knownBrowsersOf(storage: object): KnownBrowsers {
  let browsers = perStorage.get(storage);
  if (!browsers) {
    browsers = createKnownBrowsers();
    perStorage.set(storage, browsers);
  }
  return browsers;
}
