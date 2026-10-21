import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { LocationsForm } from "@/admin/settings/locations-form.tsx";
import { formWidth } from "@/admin/shell/page.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { operatorMiddleware } from "@/routes/-admin.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { probeGate } from "@/server/probes/api.ts";
import {
  makeProbe,
  readProbes,
  removeProbe,
  replaceProbeToken,
} from "@/server/probes/probes.ts";
import {
  type ProbeRemoveResult,
  type ProbesResult,
  type ProbeTokenResult,
  probeCreateSchema,
  probeIdSchema,
} from "@/shared/schemas/probe.ts";
import { cn } from "@/shared/ui/cn.ts";

// The locations page: the main location and the probes, and the three
// commands that make a probe, give it a new token and delete it.
const read = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<ProbesResult> =>
      readProbes(context.storage, Date.now(), probeGate.refusedPush)
  );

const make = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(probeCreateSchema)
  .handler(
    ({ context, data }): Promise<ProbeTokenResult> =>
      makeProbe(context.storage, data.name)
  );

const renew = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(probeIdSchema)
  .handler(
    ({ context, data }): Promise<ProbeTokenResult> =>
      replaceProbeToken(context.storage, data.id)
  );

const remove = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(probeIdSchema)
  .handler(
    ({ context, data }): Promise<ProbeRemoveResult> =>
      removeProbe(context.storage, data.id)
  );

export const Route = createFileRoute("/admin/settings/locations")({
  component: LocationsPage,
  pendingComponent: () => <CardsSkeleton header />,
  loader: async ({ abortController: { signal } }) => {
    const [result, clock] = await Promise.all([
      read({ signal }),
      readOperatorClockFn({ signal }),
    ]);
    return { clock, result };
  },
});

function LocationsPage() {
  const { clock, result } = Route.useLoaderData();
  const router = useRouter();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const makeFn = useServerFn(make);
  const renewFn = useServerFn(renew);
  const removeFn = useServerFn(remove);
  const makeCall = useCallback(
    (name: string) => makeFn({ data: { name } }),
    [makeFn]
  );
  const renewCall = useCallback(
    (id: string) => renewFn({ data: { id } }),
    [renewFn]
  );
  const removeCall = useCallback(
    (id: string) => removeFn({ data: { id } }),
    [removeFn]
  );
  const refresh = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  if (!result.ok) {
    return null;
  }
  return (
    <div className={cn("flex flex-col gap-6", formWidth)}>
      <LocationsForm
        clock={clock}
        make={makeCall}
        onChanged={refresh}
        remove={removeCall}
        renew={renewCall}
        view={result}
      />
    </div>
  );
}
