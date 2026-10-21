import { createFileRoute } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { StorageForm } from "@/admin/settings/storage-form.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { permitted } from "@/routes/-admin.ts";
import {
  readStorageSettings,
  saveStorageSettings,
} from "@/server/settings/storage.ts";
import {
  type SaveResult,
  type StorageSettings,
  type StorageSettingsInput,
  storageSettingsSchema,
} from "@/shared/schemas/settings.ts";

// The storage page: the retention and the size budget round-trip through these two server functions.
const readStorage = createServerFn({ method: "GET" })
  .middleware([permitted("settings")])
  .handler(
    ({ context }): Promise<StorageSettings> =>
      readStorageSettings(context.storage)
  );

const saveStorage = createServerFn({ method: "POST" })
  .middleware([permitted("settings")])
  .validator(storageSettingsSchema)
  .handler(
    ({ context, data }): Promise<SaveResult> =>
      saveStorageSettings(context.storage, data)
  );

export const Route = createFileRoute("/admin/settings/storage")({
  component: StoragePage,
  pendingComponent: CardsSkeleton,
  loader: ({ abortController: { signal } }) => readStorage({ signal }),
});

function StoragePage() {
  const settings = Route.useLoaderData();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const saveFn = useServerFn(saveStorage);
  const save = useCallback(
    (input: StorageSettingsInput) => saveFn({ data: input }),
    [saveFn]
  );
  return <StorageForm save={save} settings={settings} />;
}
