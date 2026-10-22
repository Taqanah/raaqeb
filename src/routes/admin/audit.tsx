import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { z } from "zod";
import { AuditPage, type AuditSearch } from "@/admin/audit/audit-page.tsx";
import { PageSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { permitted } from "@/routes/-admin.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { readAuditLog } from "@/server/audit/audit.ts";
import { readOperatorClock } from "@/server/settings/operator.ts";
import {
  type AuditFilter,
  type AuditView,
  auditFilterSchema,
} from "@/shared/schemas/audit.ts";

// The audit log, an owner's or admin's: a page of entries newest first, filtered by account, kind, refused attempts and days, read back from a time.
const searchSchema = z.object({
  actor: z.string().max(100).optional().catch(undefined),
  before: z.coerce.number().int().positive().optional().catch(undefined),
  from: z.iso.date().optional().catch(undefined),
  kind: z.string().max(40).optional().catch(undefined),
  refused: z.literal(true).optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
});

const readAuditFn = createServerFn({ method: "GET" })
  .middleware([permitted("audit")])
  .validator(auditFilterSchema)
  .handler(async ({ context, data }): Promise<AuditView | undefined> => {
    // The days are the operator's, as the page writes each entry's time.
    const { timeZone } = await readOperatorClock(
      context.storage,
      context.operator.preferences
    );
    return await readAuditLog(context.storage, data, timeZone);
  });

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
      from: deps.from,
      kind: deps.kind,
      refused: deps.refused,
      to: deps.to,
    };
    const [view, clock] = await Promise.all([
      readAuditFn({ data: filter, signal }),
      readOperatorClockFn({ signal }),
    ]);
    return { clock, now: Date.now(), view };
  },
});

function AuditRoute() {
  const { clock, now, view } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/admin/audit" });
  // Merged into the address as it is now, so two quick changes both hold; any change but paging reads from the newest entry again.
  const filter = useCallback(
    (change: AuditSearch) => {
      navigate({
        search: ({ before: _before, ...kept }) => ({ ...kept, ...change }),
      }).catch(() => undefined);
    },
    [navigate]
  );
  return (
    <AuditPage
      clock={clock}
      now={now}
      onFilter={filter}
      search={search}
      view={view}
    />
  );
}
