import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { z } from "zod";
import { AuditPage } from "@/admin/audit/audit-page.tsx";
import { PageSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { permitted } from "@/routes/-admin.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { readAuditLog } from "@/server/audit/audit.ts";
import {
  type AuditFilter,
  type AuditView,
  auditFilterSchema,
} from "@/shared/schemas/audit.ts";

// The audit log, an owner's or admin's: a page of entries newest first, filtered by account and kind, read back from a time.
const searchSchema = z.object({
  actor: z.string().max(100).optional().catch(undefined),
  before: z.coerce.number().int().positive().optional().catch(undefined),
  kind: z.string().max(40).optional().catch(undefined),
});

const readAuditFn = createServerFn({ method: "GET" })
  .middleware([permitted("audit")])
  .validator(auditFilterSchema)
  .handler(
    ({ context, data }): Promise<AuditView | undefined> =>
      readAuditLog(context.storage, data)
  );

export const Route = createFileRoute("/admin/audit")({
  // The search comes first: the loader's types are read from it.
  validateSearch: (search) => searchSchema.parse(search),
  component: AuditRoute,
  pendingComponent: () => <PageSkeleton action={[]} columns={5} />,
  loaderDeps: ({ search }) => search,
  loader: async ({ abortController: { signal }, deps }) => {
    const filter: AuditFilter = {
      actorId: deps.actor,
      before: deps.before,
      kind: deps.kind,
    };
    const [view, clock] = await Promise.all([
      readAuditFn({ data: filter, signal }),
      readOperatorClockFn({ signal }),
    ]);
    return { clock, view };
  },
});

function AuditRoute() {
  const { clock, view } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/admin/audit" });
  const filter = useCallback(
    (next: {
      readonly actor?: string;
      readonly before?: number;
      readonly kind?: string;
    }) => {
      navigate({ search: next }).catch(() => undefined);
    },
    [navigate]
  );
  return (
    <AuditPage
      actor={search.actor}
      clock={clock}
      kind={search.kind}
      onFilter={filter}
      view={view}
    />
  );
}
