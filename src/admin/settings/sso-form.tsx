/**
 * The single sign-on page (CONTEXT.md "Single sign-on", "Identity
 * provider"), an owner's: the one OIDC provider's discovery address, client
 * id and secret, the callback address to register with it, who may make an
 * account through it, how a claim maps to roles, and whether operators who
 * are not owners must use it.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { formWidth } from "@/admin/shell/page.tsx";
import { roleWords } from "@/admin/shell/role-words.ts";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type DiscoveryResult,
  type SsoInput,
  type SsoRefusal,
  type SsoRoleRule,
  type SsoSignUp,
  type SsoView,
  ssoInputSchema,
  ssoRoleSchema,
  ssoRoles,
  ssoSignUps,
} from "@/shared/schemas/sso.ts";
import { Button } from "@/shared/ui/button.tsx";
import { Card, CardContent } from "@/shared/ui/card.tsx";
import { CopyButton } from "@/shared/ui/copy-button.tsx";
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
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { Switch } from "@/shared/ui/switch.tsx";
import { Textarea } from "@/shared/ui/textarea.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { type Rejection, type SaveCall, useDraftSave } from "./use-save.ts";

const messages: Readonly<Record<SsoRefusal | Rejection, MessageId>> = {
  limited: "auth_rate_limited",
  invalid: "setting_invalid",
  secret_required: "setting_sso_secret_required",
  unavailable: "setting_unavailable",
};

const discoveryWords: Readonly<
  Record<Extract<DiscoveryResult, { ok: false }>["reason"], MessageId>
> = {
  no_keys: "setting_sso_discovery_no_keys",
  not_discovery: "setting_sso_discovery_not_discovery",
  unreachable: "setting_sso_discovery_unreachable",
};

const signUpWords: Readonly<
  Record<SsoSignUp, { readonly line: MessageId; readonly name: MessageId }>
> = {
  domains: {
    line: "setting_sso_sign_up_domains_line",
    name: "setting_sso_sign_up_domains",
  },
  invitation: {
    line: "setting_sso_sign_up_invitation_line",
    name: "setting_sso_sign_up_invitation",
  },
};

const lineBreak = /\r?\n/;
const listSeparator = /[\s,]+/;

/** The rules as typed, one `value = role` a line; nothing when a line is not one. */
function rulesOf(text: string): SsoRoleRule[] | undefined {
  const rules: SsoRoleRule[] = [];
  for (const line of text.split(lineBreak)) {
    if (line.trim() === "") {
      continue;
    }
    const at = line.lastIndexOf("=");
    const role = ssoRoleSchema.safeParse(line.slice(at + 1).trim());
    const value = line.slice(0, at).trim();
    if (at < 1 || !role.success || value === "") {
      return;
    }
    rules.push({ role: role.data, value });
  }
  return rules;
}

function rulesText(rules: readonly SsoRoleRule[]): string {
  return rules.map((rule) => `${rule.value} = ${rule.role}`).join("\n");
}

/** What the discovery test found: the issuer, or why it is not a provider Raaqeb can use. */
function DiscoveryLine({
  tested,
}: {
  readonly tested: DiscoveryResult | "pending" | undefined;
}): ReactNode {
  const { t } = useMessages();
  if (tested === undefined || tested === "pending") {
    return null;
  }
  return tested.ok ? (
    <FieldDescription data-slot="sso-tested" data-state="ok">
      {t("setting_sso_discovery_ok", { issuer: tested.issuer })}
    </FieldDescription>
  ) : (
    <FieldError data-slot="sso-tested">
      {t(discoveryWords[tested.reason])}
    </FieldError>
  );
}

export interface SsoFormProps {
  /** The callback address to register, read from the public address. */
  readonly callbackUrl: string | undefined;
  /** After a save, so the page reads the stored provider again. */
  readonly onSaved: () => void;
  readonly save: SaveCall<SsoInput, SsoRefusal>;
  readonly testDiscovery: (url: string) => Promise<DiscoveryResult>;
  /** The stored provider; nothing before the first save. */
  readonly view: SsoView | undefined;
}

export function SsoForm({
  callbackUrl,
  onSaved,
  save,
  testDiscovery,
  view,
}: SsoFormProps): ReactNode {
  const { t } = useMessages();
  const [typed, setTyped] = useState({
    clientId: view?.clientId ?? "",
    clientSecret: "",
    defaultRole: view?.defaultRole ?? "viewer",
    discoveryUrl: view?.discoveryUrl ?? "",
    domains: view?.domains.join(", ") ?? "",
    name: view?.name ?? "",
    roleClaim: view?.roleClaim ?? "groups",
    roleRules: rulesText(view?.roleRules ?? []),
  });
  const [enabled, setEnabled] = useState(view?.enabled ?? false);
  const [requireSso, setRequireSso] = useState(view?.requireSso ?? false);
  const [signUp, setSignUp] = useState<SsoSignUp>(view?.signUp ?? "invitation");
  const onTyped = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { name, value } = event.currentTarget;
      setTyped((current) => ({ ...current, [name]: value }));
    },
    []
  );
  const onRole = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const role = ssoRoleSchema.safeParse(event.currentTarget.value);
    if (role.success) {
      setTyped((current) => ({ ...current, defaultRole: role.data }));
    }
  }, []);
  const onSignUp = useCallback((value: unknown) => {
    if (value === "domains" || value === "invitation") {
      setSignUp(value);
    }
  }, []);
  const draft = { ...typed, enabled, requireSso, signUp };
  // A saved secret empties its field, which then keeps the stored one.
  const emptySecret = useCallback(() => {
    setTyped((current) => ({ ...current, clientSecret: "" }));
    onSaved();
  }, [onSaved]);
  const saving = useDraftSave(save, draft, {
    emptied: { ...draft, clientSecret: "" },
    onSaved: emptySecret,
  });
  const { fail, submit } = saving;
  const [rulesRefused, setRulesRefused] = useState(false);
  const [tested, setTested] = useState<DiscoveryResult | "pending">();
  const runTest = useCallback(() => {
    setTested("pending");
    testDiscovery(typed.discoveryUrl.trim()).then(setTested, () =>
      setTested({ ok: false, reason: "unreachable" })
    );
  }, [testDiscovery, typed.discoveryUrl]);
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const roleRules = rulesOf(typed.roleRules);
      setRulesRefused(roleRules === undefined);
      const parsed = ssoInputSchema.safeParse({
        clientId: typed.clientId,
        clientSecret:
          typed.clientSecret === "" ? undefined : typed.clientSecret,
        defaultRole: typed.defaultRole,
        discoveryUrl: typed.discoveryUrl.trim(),
        domains: typed.domains
          .split(listSeparator)
          .filter((domain) => domain !== ""),
        enabled,
        name: typed.name,
        requireSso,
        roleClaim: typed.roleClaim,
        roleRules: roleRules ?? [],
        signUp,
      });
      if (!(parsed.success && roleRules)) {
        fail("invalid");
        return;
      }
      submit(parsed.data);
    },
    [enabled, fail, requireSso, signUp, submit, typed]
  );
  const shown = useRef<HTMLElement>(null);
  return (
    <form data-slot="sso-form" method="post" noValidate onSubmit={onSubmit}>
      <Card className={formWidth}>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <Switch
                checked={enabled}
                id="enabled"
                name="enabled"
                onCheckedChange={setEnabled}
              />
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor="enabled">
                  {t("setting_sso_enabled")}
                </FieldLabel>
                <FieldDescription>
                  {t("setting_sso_enabled_hint")}
                </FieldDescription>
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="name">{t("setting_sso_name")}</FieldLabel>
              <Input
                defaultValue={typed.name}
                id="name"
                name="name"
                onChange={onTyped}
              />
              <FieldDescription>{t("setting_sso_name_hint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="discoveryUrl">
                {t("setting_sso_discovery_url")}
              </FieldLabel>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  defaultValue={typed.discoveryUrl}
                  id="discoveryUrl"
                  name="discoveryUrl"
                  onChange={onTyped}
                  type="url"
                  variant="token"
                />
                <Button
                  data-slot="sso-test"
                  disabled={
                    tested === "pending" || typed.discoveryUrl.trim() === ""
                  }
                  onClick={runTest}
                  type="button"
                  variant="outline"
                >
                  {t("setting_sso_discovery_test")}
                </Button>
              </div>
              <FieldDescription>
                {t("setting_sso_discovery_url_hint")}{" "}
                <Token>/.well-known/openid-configuration</Token>
              </FieldDescription>
              <DiscoveryLine tested={tested} />
            </Field>
            <Field>
              <FieldLabel>{t("setting_sso_callback_url")}</FieldLabel>
              {callbackUrl ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                  <Token
                    className="wrap-anywhere min-w-0 select-all py-1 sm:flex-1"
                    data-slot="sso-callback"
                    ref={shown}
                  >
                    {callbackUrl}
                  </Token>
                  <CopyButton
                    className="shrink-0 self-start"
                    size="sm"
                    target={shown}
                    text={callbackUrl}
                  />
                </div>
              ) : null}
              <FieldDescription>
                {t(
                  callbackUrl
                    ? "setting_sso_callback_url_hint"
                    : "setting_sso_callback_none"
                )}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="clientId">
                {t("setting_sso_client_id")}
              </FieldLabel>
              <Input
                defaultValue={typed.clientId}
                id="clientId"
                name="clientId"
                onChange={onTyped}
                variant="token"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="clientSecret">
                {t("setting_sso_client_secret")}
              </FieldLabel>
              <Input
                autoComplete="off"
                id="clientSecret"
                name="clientSecret"
                onChange={onTyped}
                type="password"
                value={typed.clientSecret}
              />
              <FieldDescription>
                {t(
                  view?.secretStored
                    ? "setting_sso_client_secret_kept"
                    : "setting_sso_client_secret_hint"
                )}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel id="signUp-label">
                {t("setting_sso_sign_up")}
              </FieldLabel>
              <Segmented
                aria-labelledby="signUp-label"
                name="signUp"
                onValueChange={onSignUp}
                value={signUp}
              >
                {ssoSignUps.map((each) => (
                  <SegmentedItem key={each} value={each}>
                    {t(signUpWords[each].name)}
                  </SegmentedItem>
                ))}
              </Segmented>
              <FieldDescription>{t(signUpWords[signUp].line)}</FieldDescription>
            </Field>
            {signUp === "domains" ? (
              <Field>
                <FieldLabel htmlFor="domains">
                  {t("setting_sso_domains")}
                </FieldLabel>
                <Input
                  defaultValue={typed.domains}
                  id="domains"
                  name="domains"
                  onChange={onTyped}
                  variant="token"
                />
                <FieldDescription>
                  {t("setting_sso_domains_hint")}{" "}
                  <Token>example.com, ops.example.org</Token>
                </FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="defaultRole">
                {t("setting_sso_default_role")}
              </FieldLabel>
              <NativeSelect
                id="defaultRole"
                name="defaultRole"
                onChange={onRole}
                value={typed.defaultRole}
              >
                {ssoRoles.map((role) => (
                  <NativeSelectOption key={role} value={role}>
                    {t(roleWords[role].name)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                {t("setting_sso_default_role_hint")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="roleClaim">
                {t("setting_sso_role_claim")}
              </FieldLabel>
              <Input
                defaultValue={typed.roleClaim}
                id="roleClaim"
                name="roleClaim"
                onChange={onTyped}
                variant="token"
              />
              <FieldDescription>
                {t("setting_sso_role_claim_hint")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="roleRules">
                {t("setting_sso_role_rules")}
              </FieldLabel>
              <Textarea
                aria-invalid={rulesRefused ? true : undefined}
                className="font-mono"
                defaultValue={typed.roleRules}
                dir="ltr"
                id="roleRules"
                name="roleRules"
                onChange={onTyped}
                rows={3}
              />
              <FieldDescription>
                {t("setting_sso_role_rules_hint")} <Token>sre = editor</Token>
              </FieldDescription>
              {rulesRefused ? (
                <FieldError data-error-for="roleRules">
                  {t("setting_sso_role_rules_invalid")}
                </FieldError>
              ) : null}
            </Field>
            <Field orientation="horizontal">
              <Switch
                checked={requireSso}
                id="requireSso"
                name="requireSso"
                onCheckedChange={setRequireSso}
              />
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor="requireSso">
                  {t("setting_sso_require")}
                </FieldLabel>
                <FieldDescription>
                  {t("setting_sso_require_hint")}
                </FieldDescription>
              </div>
            </Field>
          </FieldGroup>
        </CardContent>
        <SaveFooter refusals={messages} slot="save-sso" view={saving} />
      </Card>
    </form>
  );
}
