/**
 * The Playwright harness: `test`, `expect`, `expectPath`, `expectRefused`,
 * `expectSaidOnce`, `english` and `clientAddress`, imported by every spec in e2e/ instead of `@playwright/test`.
 */
import {
  test as base,
  expect as baseExpect,
  type Page,
} from "@playwright/test";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { messages as englishCatalog } from "../../locales/en/messages.ts";
import { englishOrigin, knownBrowserFile } from "./servers.ts";

declare global {
  interface Window {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: Record<string, unknown>;
    __reactHydrated?: boolean;
  }
}

/**
 * A client address no other test in the run shares: the English e2e server
 * trusts 127.0.0.1 as a proxy, so this forwarded address is the one the rate
 * rules key on, and a spec's sign-in attempts never spend another spec's
 * budget. The Arabic server trusts no proxy and ignores it.
 */
export function clientAddress(parallelIndex: number): string {
  const low = Math.floor(Math.random() * 254) + 1;
  const mid = Math.floor(Math.random() * 256);
  return `10.${parallelIndex}.${mid}.${low}`;
}

/**
 * `test` with `page.goto` and `page.reload` blocking until React has hydrated
 * the whole document (or, on a still not-found, until it is parsed), so a
 * click or a key never lands before hydration. Server-rendered markup that has
 * not hydrated does nothing, and Playwright's auto-wait cannot tell. React
 * reports each commit to the devtools hook, so an init script installs a
 * minimal hook that records the first commit to leave no Suspense boundary
 * dehydrated, and the page as hydrated once that commit's effects have run:
 * React hydrates the router's boundaries in commits after its first, and a
 * listener or a timer a page sets in an effect comes after its commit. No
 * product code is involved. Every request of the context carries the test's own client address.
 */
/** Waits for React to hydrate the whole document, or for a parsed document that carries no app script: a not-found is served still and never hydrates. */
export function hydrated(page: Page): Promise<unknown> {
  return page.waitForFunction(
    () =>
      window.__reactHydrated === true ||
      (document.readyState !== "loading" &&
        document.querySelector("script[type=module]") === null)
  );
}

/**
 * The operator's browser on the English install is a known browser, as a real
 * operator's is after their first sign-in: the install signs in once as it
 * starts (serve-en.ts) and every context carries that cookie, so the suite's
 * sign-ins to one account from fresh contexts are not a stranger's tries at
 * it. A spec that measures a stranger's sign-in uses `request`, which carries
 * no cookie.
 */
export const test = base.extend<
  { address: string },
  { knownBrowser: string | undefined }
>({
  knownBrowser: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the destructuring to order fixtures
    async ({}, use) => {
      const file = Bun.file(knownBrowserFile);
      // The install writes it a moment after it listens.
      for (let wait = 0; wait < 100; wait += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each look waits for the one before
        if (await file.exists()) {
          break;
        }
        await Bun.sleep(100);
      }
      await use((await file.exists()) ? await file.text() : undefined);
    },
    { scope: "worker" },
  ],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the destructuring to order fixtures
  address: async ({}, use, testInfo) => {
    await use(clientAddress(testInfo.parallelIndex));
  },
  page: async ({ address, context, knownBrowser, page }, use) => {
    await context.setExtraHTTPHeaders({ "x-forwarded-for": address });
    if (knownBrowser) {
      await context.addCookies([
        {
          domain: new URL(englishOrigin).hostname,
          httpOnly: true,
          name: "raaqeb.known",
          path: "/api/auth",
          sameSite: "Lax",
          value: knownBrowser,
        },
      ]);
    }
    await context.addInitScript(() => {
      /** The fields of React's fiber this hook reads; a Suspense boundary is tag 13 and holds its server markup while dehydrated. */
      interface Fiber {
        readonly child: Fiber | null;
        readonly memoizedState: { readonly dehydrated?: unknown } | null;
        readonly sibling: Fiber | null;
        readonly tag: number;
      }
      const dehydrated = (fiber: Fiber | null): boolean =>
        fiber !== null &&
        ((fiber.tag === 13 && Boolean(fiber.memoizedState?.dehydrated)) ||
          dehydrated(fiber.child) ||
          dehydrated(fiber.sibling));
      const noop = () => undefined;
      let whole = false;
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        checkDCE: noop,
        inject: () => 1,
        isDisabled: false,
        onCommitFiberRoot: (_renderer: number, root: { current: Fiber }) => {
          whole ||= !dehydrated(root.current);
        },
        onCommitFiberUnmount: noop,
        // Called once a commit's effects have run.
        onPostCommitFiberRoot: () => {
          window.__reactHydrated ||= whole;
        },
        renderers: new Map(),
        setStrictMode: noop,
        supportsFiber: true,
      };
    });
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
      const response = await goto(url, options);
      await hydrated(page);
      return response;
    };
    // A reload is a fresh document too; the init script runs again and the flag is set once it has hydrated.
    const reload = page.reload.bind(page);
    page.reload = async (options) => {
      const response = await reload(options);
      await hydrated(page);
      return response;
    };
    await use(page);
  },
});

export const expect = baseExpect;

/**
 * Asserts the URL path, retrying, then waits for the document there to
 * hydrate: signing in and signing out land on a new document, and a key or a
 * click before hydration does nothing. Never `toHaveURL(/regex/)`: it matches
 * the whole URL and passes on the page you started from.
 */
export async function expectPath(page: Page, pathname: string): Promise<void> {
  await baseExpect.poll(() => new URL(page.url()).pathname).toBe(pathname);
  await hydrated(page);
}

/**
 * Asserts that each named field of the form is marked and has the page's own
 * refusal beside it, never the browser's bubble, and that the first holds the focus.
 */
export async function expectRefused(
  page: Page,
  form: string,
  names: readonly [string, ...string[]]
): Promise<void> {
  await Promise.all(
    names.flatMap((name) => [
      baseExpect(page.locator(`${form} [name=${name}]`)).toHaveAttribute(
        "aria-invalid",
        "true"
      ),
      baseExpect(
        page.locator(`${form} [data-error-for=${name}]`)
      ).toBeVisible(),
    ])
  );
  await baseExpect(page.locator(`${form} [name=${names[0]}]`)).toBeFocused();
}

/**
 * Asserts that a refused save says its refusal once: the field's own words
 * beside it, and other words in the form's save line.
 */
export async function expectSaidOnce(
  page: Page,
  form: string,
  name: string
): Promise<void> {
  const line = page.locator(
    `${form} [data-slot=save-outcome][data-state=failed]`
  );
  await baseExpect(line).toHaveCount(1);
  const beside = await page
    .locator(`${form} [data-error-for=${name}]`)
    .textContent();
  await baseExpect(line).not.toHaveText(beside ?? "");
}

/** The English catalog's words for a message id without placeholders: what an element that carries no id of its own, such as a toast, is told apart by, never copy typed into a spec. */
export function english(id: MessageId): string {
  const words = englishCatalog[id];
  if (typeof words === "string") {
    return words;
  }
  if (Array.isArray(words) && words.every((part) => typeof part === "string")) {
    return words.join("");
  }
  throw new Error(`${id} is not plain words in the English catalog`);
}
