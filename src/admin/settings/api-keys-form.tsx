/**
 * The API keys page (CONTEXT.md "API key"): the operator's own keys with
 * their role, expiry and last use, a form that makes one and shows it once,
 * and revoking one; to an operator who manages the team, the keys of the
 * other accounts with their account.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useState,
} from "react";
import { Copyable } from "@/admin/settings/metrics-form.tsx";
import { FormFooter } from "@/admin/shell/page.tsx";
import { roleWords } from "@/admin/shell/role-words.ts";
import type { Role } from "@/shared/domain/roles.ts";
import { formatDateTime, type TimeOptions } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type ApiKey,
  type ApiKeyCreateInput,
  type ApiKeyCreateResult,
  type ApiKeyLifetime,
  type ApiKeyRevokeResult,
  type ApiKeysView,
  apiKeyLifetimes,
  apiKeyNameMaxLength,
} from "@/shared/schemas/api-key.ts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog.tsx";
import { Badge } from "@/shared/ui/badge.tsx";
import { Button } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import { Token } from "@/shared/ui/token.tsx";

export interface ApiKeysPageProps {
  readonly clock: TimeOptions;
  readonly create: (input: ApiKeyCreateInput) => Promise<ApiKeyCreateResult>;
  readonly onChanged: () => void;
  readonly revoke: (id: string) => Promise<ApiKeyRevokeResult>;
  /** Nothing when the keys could not be read. */
  readonly view: ApiKeysView | undefined;
}

const lifetimeWords: Readonly<Record<ApiKeyLifetime, MessageId>> = {
  7: "setting_api_key_expiry_7",
  30: "setting_api_key_expiry_30",
  90: "setting_api_key_expiry_90",
  365: "setting_api_key_expiry_365",
};

const never = "never";
const defaultLifetime: ApiKeyLifetime = 90;

/** The call a new key can make at once, for the operator to try it. */
function curlOf(secret: string): string {
  const origin =
    typeof window === "undefined"
      ? "https://status.example.com"
      : window.location.origin;
  return `curl -H "Authorization: Bearer ${secret}" ${origin}/api/v1/monitors`;
}

export function ApiKeysPage({
  clock,
  create,
  onChanged,
  revoke,
  view,
}: ApiKeysPageProps): ReactNode {
  const { t } = useMessages();
  const [secret, setSecret] = useState<string | undefined>();
  const done = useCallback(() => {
    setSecret(undefined);
    onChanged();
  }, [onChanged]);
  if (!view) {
    return (
      <Card>
        <CardContent>
          <FieldError>{t("setting_unavailable")}</FieldError>
        </CardContent>
      </Card>
    );
  }
  return (
    <>
      {secret === undefined ? (
        <NewKeyForm create={create} onMade={setSecret} roles={view.roles} />
      ) : (
        <SecretCard onDone={done} secret={secret} />
      )}
      <KeysCard
        clock={clock}
        description={t("setting_api_key_own_intro")}
        keys={view.own}
        onRevoked={onChanged}
        revocable={view.own.map((key) => key.id)}
        revoke={revoke}
        slot="own-keys"
        title={t("setting_api_key_own_title")}
      />
      {view.others ? (
        <KeysCard
          accounts
          clock={clock}
          description={t("setting_api_key_others_intro")}
          keys={view.others}
          onRevoked={onChanged}
          revocable={view.revocable}
          revoke={revoke}
          slot="others-keys"
          title={t("setting_api_key_others_title")}
        />
      ) : null}
    </>
  );
}

function NewKeyForm({
  create,
  onMade,
  roles,
}: {
  readonly create: (input: ApiKeyCreateInput) => Promise<ApiKeyCreateResult>;
  readonly onMade: (secret: string) => void;
  readonly roles: readonly Role[];
}): ReactNode {
  const { t } = useMessages();
  const [role, setRole] = useState<Role>(roles.at(-1) ?? "viewer");
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<MessageId | undefined>();
  const onRole = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setRole(roles.find((one) => one === event.target.value) ?? role);
    },
    [role, roles]
  );
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = String(form.get("name") ?? "").trim();
      if (name === "") {
        setRefused("setting_api_key_name_required");
        return;
      }
      const lifetime = apiKeyLifetimes.find(
        (days) => String(days) === form.get("expiresInDays")
      );
      setPending(true);
      setRefused(undefined);
      create({ expiresInDays: lifetime ?? null, name, role }).then(
        (result) => {
          setPending(false);
          if (result.ok) {
            onMade(result.secret);
          } else {
            setRefused(
              result.reason === "role"
                ? "setting_api_key_refused_role"
                : "setting_unavailable"
            );
          }
        },
        () => {
          setPending(false);
          setRefused("setting_unavailable");
        }
      );
    },
    [create, onMade, role]
  );
  return (
    <form data-slot="api-key-form" method="post" noValidate onSubmit={onSubmit}>
      <Card>
        <CardHeader divided>
          <CardTitle>{t("setting_api_key_new_title")}</CardTitle>
          <CardDescription>{t("setting_api_key_new_intro")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="apiKeyName">
                {t("setting_api_key_name")}
              </FieldLabel>
              <Input
                aria-invalid={
                  refused === "setting_api_key_name_required" ? true : undefined
                }
                autoComplete="off"
                id="apiKeyName"
                maxLength={apiKeyNameMaxLength}
                name="name"
                required
              />
              <FieldDescription>
                {t("setting_api_key_name_hint")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="apiKeyRole">
                {t("setting_api_key_role")}
              </FieldLabel>
              <NativeSelect
                className="w-full"
                id="apiKeyRole"
                name="role"
                onChange={onRole}
                value={role}
              >
                {roles.map((one) => (
                  <NativeSelectOption key={one} value={one}>
                    {t(roleWords[one].name)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription data-slot="api-key-role-line">
                {t(roleWords[role].line)} {t("setting_api_key_role_hint")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="apiKeyExpiry">
                {t("setting_api_key_expiry")}
              </FieldLabel>
              <NativeSelect
                className="w-full"
                defaultValue={String(defaultLifetime)}
                id="apiKeyExpiry"
                name="expiresInDays"
              >
                {apiKeyLifetimes.map((days) => (
                  <NativeSelectOption key={days} value={String(days)}>
                    {t(lifetimeWords[days])}
                  </NativeSelectOption>
                ))}
                <NativeSelectOption value={never}>
                  {t("setting_api_key_expiry_never")}
                </NativeSelectOption>
              </NativeSelect>
              <FieldDescription>
                {t("setting_api_key_expiry_hint")}
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
        <FormFooter
          outcome={refused ? <FieldError>{t(refused)}</FieldError> : null}
        >
          <Button data-slot="api-key-create" disabled={pending} type="submit">
            {t("setting_api_key_create")}
          </Button>
        </FormFooter>
      </Card>
    </form>
  );
}

function SecretCard({
  onDone,
  secret,
}: {
  readonly onDone: () => void;
  readonly secret: string;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Card data-slot="api-key-shown">
      <CardHeader divided>
        <CardTitle>{t("setting_api_key_secret_title")}</CardTitle>
        <CardDescription>{t("setting_api_key_secret_intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Copyable copy="api-key-secret" text={secret} />
          <div className="flex flex-col gap-2">
            <FieldLabel>{t("setting_api_key_example")}</FieldLabel>
            <Copyable block copy="api-key-example" text={curlOf(secret)} />
          </div>
        </FieldGroup>
      </CardContent>
      <FormFooter>
        <Button data-slot="api-key-done" onClick={onDone} type="button">
          {t("setting_api_key_copied")}
        </Button>
      </FormFooter>
    </Card>
  );
}

function KeysCard({
  accounts = false,
  clock,
  description,
  keys,
  onRevoked,
  revocable,
  revoke,
  slot,
  title,
}: {
  /** Each row names the key's account. */
  readonly accounts?: boolean;
  readonly clock: TimeOptions;
  readonly description: string;
  readonly keys: readonly ApiKey[];
  readonly onRevoked: () => void;
  readonly revocable: readonly string[];
  readonly revoke: (id: string) => Promise<ApiKeyRevokeResult>;
  readonly slot: string;
  readonly title: string;
}): ReactNode {
  const { t } = useMessages();
  const [asked, setAsked] = useState<ApiKey | undefined>();
  const close = useCallback(() => setAsked(undefined), []);
  const revoked = useCallback(() => {
    setAsked(undefined);
    onRevoked();
  }, [onRevoked]);
  return (
    <Card data-slot={slot}>
      <CardHeader divided>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {keys.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("setting_api_key_none")}
          </p>
        ) : (
          <FieldGroup>
            {keys.map((key) => (
              <KeyRow
                account={accounts}
                apiKey={key}
                clock={clock}
                key={key.id}
                onRevoke={revocable.includes(key.id) ? setAsked : undefined}
              />
            ))}
          </FieldGroup>
        )}
      </CardContent>
      {asked ? (
        <RevokeDialog
          apiKey={asked}
          onClose={close}
          onRevoked={revoked}
          revoke={revoke}
        />
      ) : null}
    </Card>
  );
}

function KeyRow({
  account,
  apiKey,
  clock,
  onRevoke,
}: {
  readonly account: boolean;
  readonly apiKey: ApiKey;
  readonly clock: TimeOptions;
  readonly onRevoke: ((key: ApiKey) => void) | undefined;
}): ReactNode {
  const { locale, t } = useMessages();
  const [now] = useState(() => Date.now());
  const expired = apiKey.expiresAt !== null && apiKey.expiresAt <= now;
  const ask = useCallback(() => onRevoke?.(apiKey), [apiKey, onRevoke]);
  const owner =
    apiKey.account.name === "" ? apiKey.account.email : apiKey.account.name;
  return (
    <div
      className="flex flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
      data-key={apiKey.id}
      data-slot="api-key"
    >
      <div className="flex min-w-0 flex-col gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <bdi className="font-medium">{apiKey.name}</bdi>
          <Badge variant="secondary">{t(roleWords[apiKey.role].name)}</Badge>
          {expired ? (
            <Badge variant="down">{t("setting_api_key_expired")}</Badge>
          ) : null}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
          {account ? (
            <>
              <dt>{t("setting_api_key_account")}</dt>
              <dd>
                <bdi>{owner}</bdi>
              </dd>
            </>
          ) : null}
          <dt>{t("setting_api_key_created")}</dt>
          <dd>{formatDateTime(locale, apiKey.createdAt, clock)}</dd>
          <dt>{t("setting_api_key_expires")}</dt>
          <dd>
            {apiKey.expiresAt === null
              ? t("setting_api_key_expiry_never")
              : formatDateTime(locale, apiKey.expiresAt, clock)}
          </dd>
          <dt>{t("setting_api_key_last_used")}</dt>
          {apiKey.lastUsedAt === null ? (
            <dd>{t("setting_api_key_never_used")}</dd>
          ) : (
            <dd data-slot="api-key-last-used">
              {formatDateTime(locale, apiKey.lastUsedAt, clock)}
              {apiKey.lastUsedAddress ? (
                <>
                  {" · "}
                  <Token>{apiKey.lastUsedAddress}</Token>
                </>
              ) : null}
            </dd>
          )}
        </dl>
      </div>
      {onRevoke ? (
        <Button
          className="shrink-0 self-start"
          data-slot="api-key-revoke"
          onClick={ask}
          size="sm"
          type="button"
          variant="destructive-outline"
        >
          {t("setting_api_key_revoke")}
        </Button>
      ) : null}
    </div>
  );
}

function RevokeDialog({
  apiKey,
  onClose,
  onRevoked,
  revoke,
}: {
  readonly apiKey: ApiKey;
  readonly onClose: () => void;
  readonly onRevoked: () => void;
  readonly revoke: (id: string) => Promise<ApiKeyRevokeResult>;
}): ReactNode {
  const { t } = useMessages();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirm = useCallback(() => {
    setPending(true);
    setFailed(false);
    revoke(apiKey.id).then(
      (result) => {
        setPending(false);
        // A key gone already is revoked all the same.
        if (result.ok || result.reason === "not_found") {
          onRevoked();
        } else {
          setFailed(true);
        }
      },
      () => {
        setPending(false);
        setFailed(true);
      }
    );
  }, [apiKey, onRevoked, revoke]);
  const changeOpen = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );
  return (
    <AlertDialog onOpenChange={changeOpen} open>
      <AlertDialogContent data-slot="api-key-revoke-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("setting_api_key_revoke_title")}
          </AlertDialogTitle>
          <p>
            <bdi className="font-medium">{apiKey.name}</bdi>
          </p>
          <AlertDialogDescription>
            {t("setting_api_key_revoke_description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed ? <FieldError>{t("setting_unavailable")}</FieldError> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("app_cancel")}</AlertDialogCancel>
          <Button
            data-slot="api-key-revoke-confirm"
            disabled={pending}
            onClick={confirm}
            type="button"
            variant="destructive"
          >
            {t("setting_api_key_revoke")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
