import { createFileRoute } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ExportCard, ImportCard } from "@/admin/settings/export-forms.tsx";
import { formWidth } from "@/admin/shell/page.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { operatorMiddleware, readSession } from "@/routes/-admin.ts";
import { exportSizes } from "@/server/export/export.ts";
import {
  type ExportSizes,
  exportPageSearchSchema,
} from "@/shared/schemas/export-page.ts";
import { cn } from "@/shared/ui/cn.ts";

// Each mode's file size, read after the page opens: the full one reads all history.
const readSizes = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<ExportSizes> =>
      exportSizes(context.storage, context.boot.installKey, Date.now())
  );

// The export and import page: the download's refusal comes back
// in the search, since the download is a plain GET.
export const Route = createFileRoute("/admin/settings/export")({
  component: ExportPage,
  // The page reads nothing of its own; the session check sends a caller whose session ended to sign-in.
  loader: ({ abortController: { signal } }) => readSession({ signal }),
  pendingComponent: () => <CardsSkeleton header />,
  validateSearch: exportPageSearchSchema,
});

function ExportPage() {
  const { record, refused } = Route.useSearch();
  const sizesFn = useServerFn(readSizes);
  const [sizes, setSizes] = useState<ExportSizes | undefined>();
  useEffect(() => {
    sizesFn()
      .then(setSizes)
      .catch(() => setSizes({ ok: false, reason: "unavailable" }));
  }, [sizesFn]);
  return (
    <div className={cn("flex flex-col gap-6", formWidth)}>
      <ExportCard record={record} refused={refused} sizes={sizes} />
      <ImportCard />
    </div>
  );
}
