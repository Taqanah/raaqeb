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
import { NameForm, SessionsCard } from "@/admin/settings/profile-forms.tsx";
import { formWidth } from "@/admin/shell/page.tsx";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { permitted } from "@/routes/-admin.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import {
  changeOperatorEmail,
  changeOperatorPassword,
  type EmailChangeResult,
  endOwnSessions,
  type PasswordChangeResult,
  readOwnSessions,
  renameOperator,
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
  type NameChangeInput,
  nameChangeSchema,
  type PasswordChangeInput,
  passwordChangeSchema,
  type SaveResult,
  type SessionEndInput,
  type SessionsResult,
  sessionEndSchema,
  settingsSearchSchema,
} from "@/shared/schemas/settings.ts";
import { cn } from "@/shared/ui/cn.ts";

// The account page: the operator's name, their overrides, the email
// change, the password change and their sessions. The two auth changes run
// on the server through Better Auth with the request's headers and put the
// cookies it re-issues on the response; the page reloads to adopt them.
const readAccount = createServerFn({ method: "GET" })
  .middleware([permitted("profile")])
  .handler(
    ({ context }): Promise<AccountSettings> =>
      readAccountSettings(context.storage, context.operator.preferences)
  );

const changeName = createServerFn({ method: "POST" })
  .middleware([permitted("profile")])
  .validator(nameChangeSchema)
  .handler(
    ({ context, data }): Promise<SaveResult> =>
      renameOperator(context.storage, context.operator.id, data)
  );

const readSessions = createServerFn({ method: "GET" })
  .middleware([permitted("profile")])
  .handler(
    ({ context }): Promise<SessionsResult> =>
      readOwnSessions(context.storage, context.operator, Date.now())
  );

const endSessions = createServerFn({ method: "POST" })
  .middleware([permitted("profile")])
  .validator(sessionEndSchema)
  .handler(
    ({ context, data }): Promise<SaveResult> =>
      endOwnSessions(context.storage, context.operator, data)
  );

const saveAccount = createServerFn({ method: "POST" })
  .middleware([permitted("profile")])
  .validator(accountSettingsSchema)
  .handler(
    ({ context, data }): Promise<SaveResult> =>
      saveAccountSettings(context.storage, context.operator.id, data)
  );

const changeEmail = createServerFn({ method: "POST" })
  .middleware([permitted("profile")])
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
  .middleware([permitted("profile")])
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
  loader: async ({ abortController: { signal } }) => {
    const [settings, sessions, clock] = await Promise.all([
      readAccount({ signal }),
      readSessions({ signal }),
      readOperatorClockFn({ signal }),
    ]);
    return { clock, sessions, settings };
  },
});

function AccountPage() {
  const { clock, sessions, settings } = Route.useLoaderData();
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
  const nameFn = useServerFn(changeName);
  const endFn = useServerFn(endSessions);
  const nameCall = useCallback(
    (input: NameChangeInput) => nameFn({ data: input }),
    [nameFn]
  );
  const endCall = useCallback(
    (input: SessionEndInput) => endFn({ data: input }),
    [endFn]
  );
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
      <NameForm name={operator.name} onSaved={refresh} save={nameCall} />
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
      <SessionsCard
        clock={clock}
        end={endCall}
        onEnded={refresh}
        sessions={sessions.ok ? sessions.sessions : undefined}
      />
    </div>
  );
}
