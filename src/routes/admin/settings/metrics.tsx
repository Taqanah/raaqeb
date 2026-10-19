import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { MetricsForm } from "@/admin/settings/metrics-form.tsx";
import { formWidth } from "@/admin/shell/page.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { operatorMiddleware } from "@/routes/-admin.ts";
import {
  makeMetricsToken,
  readMetrics,
  turnMetricsOff,
} from "@/server/metrics/token.ts";
import type {
  MetricsTokenResult,
  MetricsView,
} from "@/shared/schemas/metrics.ts";
import type { SaveResult } from "@/shared/schemas/settings.ts";
import { cn } from "@/shared/ui/cn.ts";

// The metrics page: the endpoint's state, and the two commands that make a
// token (turning it on, or replacing it) and forget it.
const read = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    async ({ context }): Promise<MetricsView | undefined> =>
      await readMetrics(context.storage).catch(() => undefined)
  );

const make = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<MetricsTokenResult> =>
      makeMetricsToken(context.storage)
  );

const turnOff = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<SaveResult> => turnMetricsOff(context.storage)
  );

export const Route = createFileRoute("/admin/settings/metrics")({
  component: MetricsPage,
  pendingComponent: () => <CardsSkeleton header />,
  loader: ({ abortController: { signal } }) => read({ signal }),
});

function MetricsPage() {
  const view = Route.useLoaderData();
  const router = useRouter();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const makeFn = useServerFn(make);
  const offFn = useServerFn(turnOff);
  const makeCall = useCallback(() => makeFn(), [makeFn]);
  const offCall = useCallback(() => offFn(), [offFn]);
  const refresh = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  if (!view) {
    return null;
  }
  return (
    <div className={cn("flex flex-col gap-6", formWidth)}>
      <MetricsForm
        makeToken={makeCall}
        onChanged={refresh}
        turnOff={offCall}
        view={view}
      />
    </div>
  );
}
