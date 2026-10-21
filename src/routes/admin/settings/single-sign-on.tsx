import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { z } from "zod";
import { SsoForm } from "@/admin/settings/sso-form.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { permitted } from "@/routes/-admin.ts";
import {
  readSsoView,
  saveSso,
  ssoCallbackPath,
  testDiscovery,
} from "@/server/auth/sso.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import {
  type DiscoveryResult,
  type SsoInput,
  type SsoSaveResult,
  type SsoView,
  ssoInputSchema,
} from "@/shared/schemas/sso.ts";

// The single sign-on page, an owner's: the provider round-trips through these server functions, and the discovery test fetches once from the server, as the sign-in will.
const readSso = createServerFn({ method: "GET" })
  .middleware([permitted("security")])
  .handler(
    async ({
      context,
    }): Promise<{
      readonly callbackUrl: string | undefined;
      readonly view: SsoView | undefined;
    }> => {
      const address = await readPublicAddress(context.storage).catch(
        () => undefined
      );
      const view = await readSsoView(context.storage, address).catch(
        () => undefined
      );
      return {
        callbackUrl: address ? `${address}${ssoCallbackPath}` : undefined,
        view,
      };
    }
  );

const saveSsoFn = createServerFn({ method: "POST" })
  .middleware([permitted("security")])
  .validator(ssoInputSchema)
  .handler(
    ({ context, data }): Promise<SsoSaveResult> =>
      saveSso(context.storage, context.boot.installKey, data)
  );

const testDiscoveryFn = createServerFn({ method: "POST" })
  .middleware([permitted("security")])
  .validator(z.object({ url: ssoInputSchema.shape.discoveryUrl }))
  .handler(
    ({ data }): Promise<DiscoveryResult> => testDiscovery(data.url, fetch)
  );

export const Route = createFileRoute("/admin/settings/single-sign-on")({
  component: SsoPage,
  pendingComponent: CardsSkeleton,
  loader: ({ abortController: { signal } }) => readSso({ signal }),
});

function SsoPage() {
  const { callbackUrl, view } = Route.useLoaderData();
  const router = useRouter();
  const reread = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  const saveFn = useServerFn(saveSsoFn);
  const testFn = useServerFn(testDiscoveryFn);
  const save = useCallback(
    (input: SsoInput) => saveFn({ data: input }),
    [saveFn]
  );
  const test = useCallback(
    (url: string): Promise<DiscoveryResult> =>
      testFn({ data: { url } }).catch(
        () => ({ ok: false, reason: "unreachable" }) as const
      ),
    [testFn]
  );
  return (
    <SsoForm
      callbackUrl={callbackUrl}
      onSaved={reread}
      save={save}
      testDiscovery={test}
      view={view}
    />
  );
}
