import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { ApiKeysPage } from "@/admin/settings/api-keys-form.tsx";
import { formWidth } from "@/admin/shell/page.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { permitted } from "@/routes/-admin.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { createApiKey, readApiKeys, revokeApiKey } from "@/server/api/keys.ts";
import {
  type ApiKeyCreateInput,
  type ApiKeyCreateResult,
  type ApiKeyRevokeResult,
  type ApiKeysViewResult,
  apiKeyCreateSchema,
  apiKeyIdSchema,
} from "@/shared/schemas/api-key.ts";
import { cn } from "@/shared/ui/cn.ts";

// The API keys page: the operator's own keys, making one (shown once) and
// revoking one; and every key of the install to an operator who manages
// the team, who revokes those of the accounts they manage.
const read = createServerFn({ method: "GET" })
  .middleware([permitted("profile")])
  .handler(
    ({ context }): Promise<ApiKeysViewResult> =>
      readApiKeys(context.storage, context.operator)
  );

const create = createServerFn({ method: "POST" })
  .middleware([permitted("profile")])
  .validator(apiKeyCreateSchema)
  .handler(
    ({ context, data }): Promise<ApiKeyCreateResult> =>
      createApiKey(context.storage, context.operator, data, Date.now())
  );

const revoke = createServerFn({ method: "POST" })
  .middleware([permitted("profile")])
  .validator(apiKeyIdSchema)
  .handler(
    ({ context, data }): Promise<ApiKeyRevokeResult> =>
      revokeApiKey(context.storage, context.operator, data.id)
  );

export const Route = createFileRoute("/admin/settings/api-keys")({
  component: KeysPage,
  pendingComponent: () => <CardsSkeleton header />,
  loader: async ({ abortController: { signal } }) => {
    const [keys, clock] = await Promise.all([
      read({ signal }),
      readOperatorClockFn({ signal }),
    ]);
    return { clock, keys };
  },
});

function KeysPage() {
  const { clock, keys } = Route.useLoaderData();
  const router = useRouter();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const createFn = useServerFn(create);
  const revokeFn = useServerFn(revoke);
  const createCall = useCallback(
    (input: ApiKeyCreateInput) => createFn({ data: input }),
    [createFn]
  );
  const revokeCall = useCallback(
    (id: string) => revokeFn({ data: { id } }),
    [revokeFn]
  );
  const refresh = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  return (
    <div className={cn("flex flex-col gap-6", formWidth)}>
      <ApiKeysPage
        clock={clock}
        create={createCall}
        onChanged={refresh}
        revoke={revokeCall}
        view={keys.ok ? keys : undefined}
      />
    </div>
  );
}
