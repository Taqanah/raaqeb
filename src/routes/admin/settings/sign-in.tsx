import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import {
  getRequestHeaders,
  setResponseHeader,
} from "@tanstack/react-start/server";
import { useCallback } from "react";
import { AuthenticatorForm } from "@/admin/settings/authenticator-form.tsx";
import {
  AuthEmailForm,
  SecondStepForm,
} from "@/admin/settings/sign-in-forms.tsx";
import { formWidth } from "@/admin/shell/page.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { operatorMiddleware } from "@/routes/-admin.ts";
import {
  chooseAuthEmailChannel,
  confirmApp,
  newBackupCodes,
  readSecondStep,
  sendAuthTest,
  setUpApp,
  switchSecondStep,
  turnAppOff,
} from "@/server/auth/second-step.ts";
import { smtpTimeoutMs } from "@/server/notify/channel.ts";
import {
  type AppConfirmInput,
  type AppConfirmResult,
  type AppPasswordInput,
  type AppSetupResult,
  type AuthEmailChannelInput,
  type AuthTestResult,
  appConfirmSchema,
  appPasswordSchema,
  authEmailChannelSchema,
  type BackupCodesResult,
  type SaveResult,
  type SecondStepInput,
  type SecondStepResult,
  type SecondStepView,
  secondStepSchema,
} from "@/shared/schemas/settings.ts";
import { cn } from "@/shared/ui/cn.ts";

// The sign-in settings page: the email channel auth mail goes
// through, its test message, the second step's switch and the authenticator
// app with its backup codes, which run on the server through Better
// Auth with the request's headers and put the session cookie it re-issues on
// the response.
const read = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    async ({ context }): Promise<SecondStepView | undefined> =>
      await readSecondStep(context.storage).catch(() => undefined)
  );

const choose = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(authEmailChannelSchema)
  .handler(
    ({ context, data }): Promise<SaveResult> =>
      chooseAuthEmailChannel(context.storage, data.channelId)
  );

/** A test waits on the network for up to an SMTP attempt, past Bun's ten idle seconds. */
const testHoldSeconds = smtpTimeoutMs / 1000 + 10;

// The channel picked on the screen, saved or not: the test is of what Save would store.
const test = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(authEmailChannelSchema)
  .handler(({ context, data }): Promise<AuthTestResult> => {
    context.holdOpen(testHoldSeconds);
    return sendAuthTest(
      context.storage,
      context.boot.installKey,
      { fetch, now: Date.now },
      data.channelId
    );
  });

const change = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(secondStepSchema)
  .handler(async ({ context, data }): Promise<SecondStepResult> => {
    const result = await switchSecondStep(
      context.auth,
      new Headers(getRequestHeaders()),
      context.storage,
      data
    );
    if (result.ok && result.setCookies.length > 0) {
      setResponseHeader("set-cookie", [...result.setCookies]);
    }
    return result;
  });

const setUp = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(appPasswordSchema)
  .handler(
    ({ context, data }): Promise<AppSetupResult> =>
      setUpApp(context.auth, new Headers(getRequestHeaders()), data)
  );

const confirm = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(appConfirmSchema)
  .handler(async ({ context, data }): Promise<AppConfirmResult> => {
    const result = await confirmApp(
      context.auth,
      new Headers(getRequestHeaders()),
      data
    );
    // The first code turns the second step on, and Better Auth re-issues the session with it.
    if (result.ok && result.setCookies.length > 0) {
      setResponseHeader("set-cookie", [...result.setCookies]);
    }
    return result;
  });

const appOff = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(appPasswordSchema)
  .handler(async ({ context, data }): Promise<SecondStepResult> => {
    const result = await turnAppOff(
      context.auth,
      new Headers(getRequestHeaders()),
      context.storage,
      data
    );
    // With no emailed codes ready the second step goes off too, and Better Auth re-issues the session.
    if (result.ok && result.setCookies.length > 0) {
      setResponseHeader("set-cookie", [...result.setCookies]);
    }
    return result;
  });

const newCodes = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(appPasswordSchema)
  .handler(
    ({ context, data }): Promise<BackupCodesResult> =>
      newBackupCodes(context.auth, new Headers(getRequestHeaders()), data)
  );

export const Route = createFileRoute("/admin/settings/sign-in")({
  component: SignInSettingsPage,
  pendingComponent: () => <CardsSkeleton header />,
  loader: ({ abortController: { signal } }) => read({ signal }),
});

function SignInSettingsPage() {
  const view = Route.useLoaderData();
  const router = useRouter();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const chooseFn = useServerFn(choose);
  const testFn = useServerFn(test);
  const changeFn = useServerFn(change);
  const setUpFn = useServerFn(setUp);
  const confirmFn = useServerFn(confirm);
  const newCodesFn = useServerFn(newCodes);
  const appOffFn = useServerFn(appOff);
  const chooseCall = useCallback(
    (input: AuthEmailChannelInput) => chooseFn({ data: input }),
    [chooseFn]
  );
  const testCall = useCallback(
    (input: AuthEmailChannelInput) => testFn({ data: input }),
    [testFn]
  );
  const changeCall = useCallback(
    (input: SecondStepInput) => changeFn({ data: input }),
    [changeFn]
  );
  const setUpCall = useCallback(
    (input: AppPasswordInput) => setUpFn({ data: input }),
    [setUpFn]
  );
  const confirmCall = useCallback(
    (input: AppConfirmInput) => confirmFn({ data: input }),
    [confirmFn]
  );
  const newCodesCall = useCallback(
    (input: AppPasswordInput) => newCodesFn({ data: input }),
    [newCodesFn]
  );
  const appOffCall = useCallback(
    (input: AppPasswordInput) => appOffFn({ data: input }),
    [appOffFn]
  );
  const refresh = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  if (!view) {
    return null;
  }
  return (
    <div className={cn("flex flex-col gap-6", formWidth)}>
      <AuthEmailForm
        choose={chooseCall}
        onChanged={refresh}
        sendTest={testCall}
        view={view}
      />
      <SecondStepForm change={changeCall} onChanged={refresh} view={view} />
      <AuthenticatorForm
        confirm={confirmCall}
        newCodes={newCodesCall}
        onChanged={refresh}
        setUp={setUpCall}
        turnOff={appOffCall}
        view={view}
      />
    </div>
  );
}
