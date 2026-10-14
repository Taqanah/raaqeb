import {
  createFileRoute,
  getRouteApi,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import {
  getRequestHeaders,
  setResponseHeader,
} from "@tanstack/react-start/server";
import { useCallback } from "react";
import {
  EmailForm,
  OverridesForm,
  PasswordForm,
} from "@/admin/settings/account-forms.tsx";
import { useLanguagePreview } from "@/admin/settings/language-preview.ts";
import { formWidth } from "@/admin/shell/page.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { operatorMiddleware } from "@/routes/-admin.ts";
import {
  changeOperatorEmail,
  changeOperatorPassword,
  type EmailChangeResult,
  type PasswordChangeResult,
} from "@/server/auth/account.ts";
import { emailChangeNoticeOver } from "@/server/auth/mail.ts";
import { error as logError } from "@/server/log.ts";
import {
  readAccountSettings,
  saveAccountSettings,
} from "@/server/settings/account.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import {
  type AccountSettings,
  type AccountSettingsInput,
  accountSettingsSchema,
  type EmailChangeInput,
  emailChangeSchema,
  type PasswordChangeInput,
  passwordChangeSchema,
  type SaveResult,
  settingsSearchSchema,
} from "@/shared/schemas/settings.ts";
import { cn } from "@/shared/ui/cn.ts";

// The account page: the operator's overrides, the email
// change and the password change. The two auth changes run on the server
// through Better Auth with the request's headers and put the cookies it
// re-issues on the response; the page reloads to adopt them.
const readAccount = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<AccountSettings> =>
      readAccountSettings(context.storage)
  );

const saveAccount = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(accountSettingsSchema)
  .handler(
    ({ context, data }): Promise<SaveResult> =>
      saveAccountSettings(context.storage, data)
  );

const changeEmail = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(emailChangeSchema)
  .handler(async ({ context, data }): Promise<EmailChangeResult> => {
    const result = await changeOperatorEmail(
      context.auth,
      new Headers(getRequestHeaders()),
      data,
      emailChangeNoticeOver(
        context.storage,
        context.boot.installKey,
        { fetch, now: Date.now },
        logError
      )
    );
    if (result.ok && result.setCookies.length > 0) {
      setResponseHeader("set-cookie", [...result.setCookies]);
    }
    return result;
  });

const changePassword = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(passwordChangeSchema)
  .handler(async ({ context, data }): Promise<PasswordChangeResult> => {
    const result = await changeOperatorPassword(
      context.auth,
      new Headers(getRequestHeaders()),
      data
    );
    if (result.ok && result.setCookies.length > 0) {
      setResponseHeader("set-cookie", [...result.setCookies]);
    }
    return result;
  });

const adminRoute = getRouteApi("/admin");

export const Route = createFileRoute("/admin/settings/account")({
  // A language picked and not yet saved renders the page in it.
  validateSearch: settingsSearchSchema,
  component: AccountPage,
  pendingComponent: () => <CardsSkeleton header />,
  loader: ({ abortController: { signal } }) => readAccount({ signal }),
});

function AccountPage() {
  const settings = Route.useLoaderData();
  // The shell's read carries the operator, re-read by the refresh below.
  const { operator } = adminRoute.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const show = useCallback(
    (locale: Locale | undefined) =>
      navigate({ replace: true, search: { locale } }),
    [navigate]
  );
  const preview = useLanguagePreview(show);
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const saveFn = useServerFn(saveAccount);
  const emailFn = useServerFn(changeEmail);
  const passwordFn = useServerFn(changePassword);
  const saveCall = useCallback(
    (input: AccountSettingsInput) => saveFn({ data: input }),
    [saveFn]
  );
  const emailCall = useCallback(
    (input: EmailChangeInput) => emailFn({ data: input }),
    [emailFn]
  );
  const passwordCall = useCallback(
    (input: PasswordChangeInput) => passwordFn({ data: input }),
    [passwordFn]
  );
  // The browser holds the re-issued cookie already; re-reading the loaders shows the new address.
  const refresh = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  // A saved language drops the preview's ?locale=, and the root reads its catalog again, as the preview does.
  const saved = useCallback(() => {
    navigate({ replace: true, search: {} })
      .then(() => router.invalidate())
      .catch(() => undefined);
  }, [navigate, router]);
  return (
    <div className={cn("flex flex-col gap-6", formWidth)}>
      <OverridesForm
        onPreviewLanguage={preview}
        onSaved={saved}
        save={saveCall}
        settings={settings}
      />
      <EmailForm
        change={emailCall}
        email={operator.email}
        onChanged={refresh}
      />
      <PasswordForm change={passwordCall} onChanged={refresh} />
    </div>
  );
}
