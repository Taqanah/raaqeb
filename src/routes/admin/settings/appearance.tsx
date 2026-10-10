import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { AppearanceForm } from "@/admin/settings/appearance-form.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { operatorMiddleware } from "@/routes/-admin.ts";
import {
  readAppearance,
  saveAppearance,
} from "@/server/settings/appearance.ts";
import {
  type Appearance,
  appearanceSchema,
} from "@/shared/schemas/appearance.ts";
import type { SaveResult } from "@/shared/schemas/settings.ts";

// The appearance page: the four scales, read by the root loader
// into the document's data attributes on the next load.
const read = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<Appearance> => readAppearance(context.storage)
  );

const save = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(appearanceSchema)
  .handler(
    ({ context, data }): Promise<SaveResult> =>
      saveAppearance(context.storage, data)
  );

export const Route = createFileRoute("/admin/settings/appearance")({
  component: AppearancePage,
  pendingComponent: CardsSkeleton,
  loader: ({ abortController: { signal } }) => read({ signal }),
});

function AppearancePage() {
  const appearance = Route.useLoaderData();
  const router = useRouter();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const saveFn = useServerFn(save);
  const saveCall = useCallback(
    (input: Appearance) => saveFn({ data: input }),
    [saveFn]
  );
  // The root loader re-reads the settings, so the document's attributes follow without a full load.
  const refresh = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  return (
    <AppearanceForm appearance={appearance} onSaved={refresh} save={saveCall} />
  );
}
