import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import {
  createIsomorphicFn,
  createServerFn,
  useServerFn,
} from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Suspense, useEffect } from "react";
import { OperatorCalendarProvider } from "@/admin/shell/calendar.tsx";
import { InstallLanguageProvider } from "@/admin/shell/content.tsx";
import { AdminShell } from "@/admin/shell/shell.tsx";
import type { Operator } from "@/server/auth/session.ts";
import { readNewerRelease, refreshRelease } from "@/server/release/release.ts";
import { readInstallLanguage } from "@/server/settings/language.ts";
import { readOperatorClock } from "@/server/settings/operator.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { Calendar } from "@/shared/schemas/clock.ts";
import type { Release } from "@/shared/schemas/release.ts";
import { sidebarOpenFromCookie } from "@/shared/ui/sidebar.tsx";
import { operatorMiddleware, readSession } from "./-admin.ts";
import { readMonitorChoicesFn } from "./-monitors.ts";
import { requireOnboardingDone } from "./-onboarding.ts";

// The admin route guard: every route under /admin needs a
// signed-in operator, read on the server from the session cookie by the
// operator middleware, which sends a request without one to the sign-in page
// and forwards a refreshed cookie. During onboarding the request goes to
// onboarding first. The shell renders around every admin page
// from here.
//
// The guard on the server render: onboarding first, then the session. On a
// client navigation a click between admin pages skips it: every
// admin page reads through a server function behind the operator
// middleware, which sends a caller whose session ended to sign-in. Entering
// the admin from outside it still checks the session before anything
// renders, since a cached admin page would otherwise show before its
// reload's redirect; a session means onboarding is over.
const guard = createIsomorphicFn()
  .server(async (_cause: string): Promise<void> => {
    await requireOnboardingDone();
    await readSession();
  })
  .client(async (cause: string): Promise<void> => {
    if (cause === "enter") {
      await readSession();
    }
  });

interface ShellData {
  /** The calendar the operator reads dates in, for the pages that load no clock. */
  readonly calendar: Calendar;
  /** Whose text install-wide content requires. */
  readonly installLanguage: Locale;
  readonly operator: Operator;
  readonly release: Release | undefined;
  readonly sidebarOpen: boolean;
}

// What the shell needs for its first paint: the operator, the release, the
// sidebar and the operator's calendar. The daily release check runs in the
// background from here when its stored answer is older than a day; the
// banner shows the answer of an earlier visit, never waits for this one. The
// router reads it again only when the operator enters /admin or a page
// invalidates the matches, never on a click between admin pages
// (load-client.js, the "stay" rule).
const readShell = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(async ({ context }): Promise<ShellData> => {
    const headers = new Headers(getRequestHeaders());
    refreshRelease(context.storage, { fetch, now: Date.now }).catch(
      () => undefined
    );
    return {
      calendar: (await readOperatorClock(context.storage)).calendar,
      installLanguage: await readInstallLanguage(context.storage),
      operator: context.operator,
      release: await readNewerRelease(context.storage),
      sidebarOpen: sidebarOpenFromCookie(headers.get("cookie")),
    };
  });

export const Route = createFileRoute("/admin")({
  beforeLoad: ({ cause }) => guard(cause),
  component: AdminLayout,
  loader: ({ abortController: { signal } }) => readShell({ signal }),
});

function AdminLayout() {
  const { calendar, installLanguage, operator, release, sidebarOpen } =
    Route.useLoaderData();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const readMonitors = useServerFn(readMonitorChoicesFn);
  const router = useRouter();
  // Each page's skeleton is a chunk of its own (vite.config.ts); loaded once the shell is up, it is there when a click asks for it.
  useEffect(() => {
    for (const route of Object.values(router.routesById)) {
      route.options.pendingComponent?.preload?.();
    }
  }, [router]);
  return (
    <AdminShell
      operatorEmail={operator.email}
      readMonitors={readMonitors}
      release={release}
      sidebarOpen={sidebarOpen}
    >
      <InstallLanguageProvider value={installLanguage}>
        <OperatorCalendarProvider value={calendar}>
          {/* A page whose skeleton has not loaded yet suspends here, inside the shell, not at the document's root. */}
          <Suspense>
            <Outlet />
          </Suspense>
        </OperatorCalendarProvider>
      </InstallLanguageProvider>
    </AdminShell>
  );
}
