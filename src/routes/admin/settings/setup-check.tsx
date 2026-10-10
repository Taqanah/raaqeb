import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  SetupCheckList,
  SetupCheckSkeleton,
} from "@/admin/settings/setup-check-list.tsx";
import { operatorMiddleware } from "@/routes/-admin.ts";
import { readSetupChecks } from "@/server/settings/setup-check.ts";
import type { SetupCheck } from "@/shared/schemas/setup-check.ts";

// A POST, though it writes nothing: a browser sends its Origin on a POST alone, and the public address check compares it.
const checkSetup = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<SetupCheck[]> =>
      readSetupChecks(context.storage, context.boot, {
        headers: getRequest().headers,
        peer: context.peer?.(),
      })
  );

export const Route = createFileRoute("/admin/settings/setup-check")({
  component: SetupCheckPage,
  loader: ({ abortController: { signal } }) => checkSetup({ signal }),
  // With ssr off the server sends this for a direct load too, so it takes the page's own shape.
  pendingComponent: SetupCheckSkeleton,
  // The loader runs in the browser, so even the first load reaches the server as the browser's own POST.
  ssr: false,
});

function SetupCheckPage() {
  return <SetupCheckList checks={Route.useLoaderData()} />;
}
