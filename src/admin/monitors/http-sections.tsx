/**
 * The HTTP monitor's sections of the form: the success rules
 * with its assertion editor, the request with its authentication and custom
 * headers, and the certificate expiry option beside the capture mode with
 * its cost sentence. A stored secret is never in the draft: its field stays
 * empty and says so, and the server keeps it.
 */
import type { MouseEvent, ReactNode } from "react";
import { formatUnit } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { oauthMethods } from "@/shared/schemas/credentials.ts";
import { captureModes } from "@/shared/schemas/monitor.ts";
import { Button } from "@/shared/ui/button.tsx";
import { Field, FieldDescription, FieldLabel } from "@/shared/ui/field.tsx";
import { PlusIcon, XIcon } from "@/shared/ui/icons.tsx";
import { Input } from "@/shared/ui/input.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import { Textarea } from "@/shared/ui/textarea.tsx";
import {
  type AssertionDraft,
  assertionFields,
  assertionKinds,
  authKinds,
  captureBytesPerDay,
  type FieldErrors,
  isHttps,
} from "./draft.ts";
import {
  ChoiceField,
  type FieldChange,
  FlagField,
  Problem,
  Section,
  type SectionProps,
  TextField,
} from "./form-parts.tsx";

/** Adds or removes a row; the button's `data-index` names the row to remove. */
export interface RowActions {
  readonly onAddAssertion: () => void;
  readonly onAddHeader: () => void;
  readonly onRemoveAssertion: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onRemoveHeader: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function SuccessRuleSection({
  draft,
  errors,
  onAddAssertion,
  onField,
  onRemoveAssertion,
}: SectionProps & RowActions): ReactNode {
  const { t } = useMessages();
  return (
    <Section
      description={t("monitor_section_success_rule_hint")}
      slot="success-rule"
      title={t("monitor_section_success_rule")}
    >
      <ol className="flex flex-col divide-y">
        {draft.assertions.map((row, index) => (
          <AssertionRow
            errors={errors}
            index={index}
            key={row.key}
            onField={onField}
            onRemove={onRemoveAssertion}
            removable={draft.assertions.length > 1}
            row={row}
          />
        ))}
      </ol>
      <Button
        className="self-start"
        data-slot="add-assertion"
        onClick={onAddAssertion}
        type="button"
        variant="outline"
      >
        <PlusIcon />
        {t("monitor_add_assertion")}
      </Button>
    </Section>
  );
}

const kindLabels: Readonly<Record<AssertionDraft["kind"], MessageId>> = {
  body_contains: "monitor_assertion_body_contains",
  body_not_contains: "monitor_assertion_body_not_contains",
  header_equals: "monitor_assertion_header_equals",
  json_equals: "monitor_assertion_json_equals",
  json_matches: "monitor_assertion_json_matches",
  response_time_under: "monitor_assertion_response_time_under",
  status: "monitor_assertion_status",
};

export function assertionKindLabel(kind: AssertionDraft["kind"]): MessageId {
  return kindLabels[kind];
}

type AssertionField = (typeof assertionFields)[number];

interface RowProps {
  readonly errors: FieldErrors;
  readonly index: number;
  readonly onField: FieldChange;
  readonly row: AssertionDraft;
}

function AssertionRow({
  onRemove,
  removable,
  ...props
}: RowProps & {
  readonly onRemove: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly removable: boolean;
}): ReactNode {
  const { t } = useMessages();
  const { errors, index, onField, row } = props;
  const path = `config.assertions.${index}`;
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0" data-assertion={index}>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          aria-label={t("monitor_assertion_kind")}
          className="w-full sm:w-56"
          name={`assertions.${index}.kind`}
          onChange={onField}
          value={row.kind}
        >
          {assertionKinds.map((kind) => (
            <NativeSelectOption key={kind} value={kind}>
              {t(kindLabels[kind])}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <AssertionInputs {...props} />
        <Button
          aria-label={t("monitor_remove_assertion")}
          data-index={index}
          disabled={!removable}
          onClick={onRemove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      {assertionFields.map((field) => (
        <Problem errors={errors} key={field} path={`${path}.${field}`} />
      ))}
    </li>
  );
}

/** One text input of an assertion row, named `assertions.<index>.<field>`. */
function AssertionInput({
  dir = "ltr",
  errors,
  field,
  index,
  label,
  onField,
  row,
}: RowProps & {
  readonly dir?: "auto" | "ltr";
  readonly field: AssertionField;
  readonly label: MessageId;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Input
      aria-invalid={
        errors[`config.assertions.${index}.${field}`] ? true : undefined
      }
      aria-label={t(label)}
      // A 10rem floor wraps a header's name and value onto their own line before either is cut to a few letters.
      className="min-w-0 flex-1 basis-40"
      // A number of milliseconds is a quantity, not a token: it follows the page's direction.
      dir={field === "ms" ? undefined : dir}
      name={`assertions.${index}.${field}`}
      onChange={onField}
      placeholder={t(label)}
      spellCheck={false}
      unit={field === "ms" ? t("monitor_unit_ms") : undefined}
      value={row[field]}
      // Codes, paths, patterns and header names are tokens; a number of milliseconds and free text are not.
      variant={dir === "ltr" && field !== "ms" ? "token" : undefined}
    />
  );
}

/** The inputs of one assertion row, by its kind. */
function AssertionInputs(props: RowProps): ReactNode {
  switch (props.row.kind) {
    case "status":
      return (
        <AssertionInput
          {...props}
          field="codes"
          label="monitor_assertion_codes"
        />
      );
    case "body_contains":
    case "body_not_contains":
      return (
        <AssertionInput
          {...props}
          dir="auto"
          field="text"
          label="monitor_assertion_text"
        />
      );
    case "json_equals":
      return (
        <>
          <AssertionInput
            {...props}
            field="path"
            label="monitor_assertion_path"
          />
          <AssertionInput
            {...props}
            dir="auto"
            field="value"
            label="monitor_assertion_value"
          />
        </>
      );
    case "json_matches":
      return (
        <>
          <AssertionInput
            {...props}
            field="path"
            label="monitor_assertion_path"
          />
          <AssertionInput
            {...props}
            field="pattern"
            label="monitor_assertion_pattern"
          />
        </>
      );
    case "header_equals":
      return (
        <>
          <AssertionInput
            {...props}
            field="name"
            label="monitor_assertion_header"
          />
          <AssertionInput
            {...props}
            dir="auto"
            field="value"
            label="monitor_assertion_value"
          />
        </>
      );
    default:
      return (
        <AssertionInput {...props} field="ms" label="monitor_assertion_ms" />
      );
  }
}

const authLabels = {
  basic: "monitor_auth_basic",
  bearer: "monitor_auth_bearer",
  none: "monitor_auth_none",
  oauth2: "monitor_auth_oauth2",
} as const;

export function RequestSection({
  draft,
  errors,
  onAddHeader,
  onChoice,
  onField,
  onFlag,
  onRemoveHeader,
}: SectionProps & RowActions): ReactNode {
  const { t } = useMessages();
  const bodyless = draft.method === "GET" || draft.method === "HEAD";
  const kept = t("monitor_secret_kept");
  return (
    <Section
      description={t("monitor_section_request_hint")}
      slot="request"
      title={t("monitor_section_request")}
    >
      <Field>
        <FieldLabel htmlFor="body">{t("monitor_field_body")}</FieldLabel>
        <Textarea
          className="font-mono"
          dir="ltr"
          disabled={bodyless}
          id="body"
          name="body"
          onChange={onField}
          spellCheck={false}
          value={draft.body}
        />
        {bodyless ? (
          <FieldDescription>{t("monitor_field_body_hint")}</FieldDescription>
        ) : null}
        <Problem errors={errors} path="config.body" />
      </Field>
      <FlagField
        checked={draft.followRedirects}
        label={t("monitor_field_follow_redirects")}
        name="followRedirects"
        onFlag={onFlag}
      />
      <FlagField
        checked={draft.ignoreTlsErrors}
        hint={t("monitor_field_ignore_tls_hint")}
        label={t("monitor_field_ignore_tls")}
        name="ignoreTlsErrors"
        onFlag={onFlag}
      />
      <ChoiceField
        choices={authKinds.map((kind) => ({
          label: t(authLabels[kind]),
          value: kind,
        }))}
        label={t("monitor_field_auth")}
        name="auth"
        onChoice={onChoice}
        value={draft.auth}
      />
      {draft.auth === "basic" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            autoComplete="off"
            errors={errors}
            label={t("monitor_field_user")}
            name="user"
            onField={onField}
            path="credentials.auth.user"
            value={draft.user}
            variant="token"
          />
          <TextField
            autoComplete="new-password"
            dir="ltr"
            errors={errors}
            label={t("monitor_field_password")}
            name="password"
            onField={onField}
            path="credentials.auth.password"
            placeholder={draft.storedAuth === "basic" ? kept : undefined}
            type="password"
            value={draft.password}
          />
        </div>
      ) : null}
      {draft.auth === "bearer" ? (
        <TextField
          autoComplete="off"
          dir="ltr"
          errors={errors}
          label={t("monitor_field_token")}
          name="token"
          onField={onField}
          path="credentials.auth.token"
          placeholder={draft.storedAuth === "bearer" ? kept : undefined}
          type="password"
          value={draft.token}
        />
      ) : null}
      {draft.auth === "oauth2" ? (
        <OAuthFields
          draft={draft}
          errors={errors}
          kept={kept}
          onChoice={onChoice}
          onField={onField}
        />
      ) : null}
      <Headers
        draft={draft}
        errors={errors}
        kept={kept}
        onAddHeader={onAddHeader}
        onField={onField}
        onRemoveHeader={onRemoveHeader}
      />
      <TextField
        autoComplete="off"
        dir="ltr"
        errors={errors}
        hint={t("monitor_field_proxy_hint")}
        label={t("monitor_field_proxy")}
        name="proxy"
        onField={onField}
        path="config.proxy"
        value={draft.proxy}
        variant="token"
      />
      {draft.proxy.trim() === "" ? null : (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            autoComplete="off"
            errors={errors}
            label={t("monitor_field_proxy_user")}
            name="proxyUser"
            onField={onField}
            path="credentials.proxyAuth.user"
            value={draft.proxyUser}
            variant="token"
          />
          <TextField
            autoComplete="new-password"
            dir="ltr"
            errors={errors}
            label={t("monitor_field_proxy_password")}
            name="proxyPassword"
            onField={onField}
            path="credentials.proxyAuth.password"
            placeholder={draft.storedProxyAuth ? kept : undefined}
            type="password"
            value={draft.proxyPassword}
          />
        </div>
      )}
    </Section>
  );
}

/** The OAuth 2.0 client credentials grant's fields: the token endpoint, the client ID and secret, the optional scope and audience, and how the client authenticates. The secret is stored sealed, never shown again, and kept when the field stays empty. */
function OAuthFields({
  draft,
  errors,
  kept,
  onChoice,
  onField,
}: Pick<SectionProps, "draft" | "errors" | "onChoice" | "onField"> & {
  readonly kept: string;
}): ReactNode {
  const { t } = useMessages();
  return (
    <>
      <TextField
        autoComplete="off"
        dir="ltr"
        errors={errors}
        hint={t("monitor_field_oauth_token_url_hint")}
        label={t("monitor_field_oauth_token_url")}
        name="oauthTokenUrl"
        onField={onField}
        path="credentials.auth.tokenUrl"
        value={draft.oauthTokenUrl}
        variant="token"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          autoComplete="off"
          dir="ltr"
          errors={errors}
          label={t("monitor_field_oauth_client_id")}
          name="oauthClientId"
          onField={onField}
          path="credentials.auth.clientId"
          value={draft.oauthClientId}
          variant="token"
        />
        <TextField
          autoComplete="new-password"
          dir="ltr"
          errors={errors}
          label={t("monitor_field_oauth_client_secret")}
          name="oauthClientSecret"
          onField={onField}
          path="credentials.auth.clientSecret"
          placeholder={draft.storedAuth === "oauth2" ? kept : undefined}
          type="password"
          value={draft.oauthClientSecret}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          autoComplete="off"
          dir="ltr"
          errors={errors}
          hint={t("monitor_field_oauth_scope_hint")}
          label={t("monitor_field_oauth_scope")}
          name="oauthScope"
          onField={onField}
          path="credentials.auth.scope"
          value={draft.oauthScope}
          variant="token"
        />
        <TextField
          autoComplete="off"
          dir="ltr"
          errors={errors}
          hint={t("monitor_field_oauth_audience_hint")}
          label={t("monitor_field_oauth_audience")}
          name="oauthAudience"
          onField={onField}
          path="credentials.auth.audience"
          value={draft.oauthAudience}
          variant="token"
        />
      </div>
      <ChoiceField
        choices={oauthMethods.map((method) => ({
          hint: t(oauthMethodHints[method]),
          label: t(oauthMethodLabels[method]),
          value: method,
        }))}
        label={t("monitor_field_oauth_method")}
        name="oauthMethod"
        onChoice={onChoice}
        value={draft.oauthMethod}
      />
    </>
  );
}

const oauthMethodLabels = {
  basic: "monitor_oauth_method_basic",
  body: "monitor_oauth_method_body",
} as const;

const oauthMethodHints = {
  basic: "monitor_oauth_method_basic_hint",
  body: "monitor_oauth_method_body_hint",
} as const;

/** A PEM text field: a monospace, left-to-right box for a certificate or a key, its hint and its refusal under it; a stored secret says so in its placeholder. */
function PemField({
  errors,
  hint,
  label,
  name,
  onField,
  path,
  placeholder,
  value,
}: Pick<SectionProps, "errors" | "onField"> & {
  readonly hint?: string;
  readonly label: string;
  readonly name: string;
  readonly path: string;
  readonly placeholder?: string;
  readonly value: string;
}): ReactNode {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Textarea
        aria-invalid={errors[path] ? true : undefined}
        autoComplete="off"
        className="font-mono text-xs"
        dir="ltr"
        id={name}
        name={name}
        onChange={onField}
        placeholder={placeholder}
        rows={4}
        spellCheck={false}
        value={value}
      />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      <Problem errors={errors} path={path} />
    </Field>
  );
}

/** The HTTP monitor's TLS material: the CA certificates it trusts and the client certificate it presents with its key and passphrase. The key and passphrase are secrets: stored sealed, never shown again, kept when the field stays empty. */
export function TlsSection({
  draft,
  errors,
  onField,
}: SectionProps): ReactNode {
  const { t } = useMessages();
  const kept = t("monitor_secret_kept");
  const presenting = draft.clientCertificate.trim() !== "";
  return (
    <Section
      description={t("monitor_section_tls_hint")}
      slot="tls"
      title={t("monitor_section_tls")}
    >
      <PemField
        errors={errors}
        hint={t("monitor_field_ca_certificates_hint")}
        label={t("monitor_field_ca_certificates")}
        name="caCertificates"
        onField={onField}
        path="config.caCertificates"
        value={draft.caCertificates}
      />
      <PemField
        errors={errors}
        hint={t("monitor_field_client_certificate_hint")}
        label={t("monitor_field_client_certificate")}
        name="clientCertificate"
        onField={onField}
        path="config.clientCertificate"
        value={draft.clientCertificate}
      />
      {presenting ? (
        <>
          <PemField
            errors={errors}
            hint={t("monitor_field_client_key_hint")}
            label={t("monitor_field_client_key")}
            name="clientKey"
            onField={onField}
            path="credentials.clientKey.key"
            placeholder={draft.storedClientKey ? kept : undefined}
            value={draft.clientKey}
          />
          <TextField
            autoComplete="new-password"
            dir="ltr"
            errors={errors}
            hint={t("monitor_field_client_passphrase_hint")}
            label={t("monitor_field_client_passphrase")}
            name="clientPassphrase"
            onField={onField}
            path="credentials.clientKey.passphrase"
            // Kept while the stored key is; a key typed anew brings its own passphrase, or none.
            placeholder={
              draft.storedClientKey && draft.clientKey.trim() === ""
                ? kept
                : undefined
            }
            type="password"
            value={draft.clientPassphrase}
          />
        </>
      ) : null}
    </Section>
  );
}

function Headers({
  draft,
  errors,
  kept,
  onAddHeader,
  onField,
  onRemoveHeader,
}: Pick<SectionProps, "draft" | "errors" | "onField"> &
  Pick<RowActions, "onAddHeader" | "onRemoveHeader"> & {
    readonly kept: string;
  }): ReactNode {
  const { t } = useMessages();
  return (
    <>
      <Field>
        <FieldLabel>{t("monitor_field_headers")}</FieldLabel>
        <FieldDescription>{t("monitor_field_headers_hint")}</FieldDescription>
        {draft.headers.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {draft.headers.map((row, index) => {
              const path = `credentials.headers.${index}`;
              return (
                <li className="flex flex-col gap-1" key={row.key}>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-invalid={errors[`${path}.name`] ? true : undefined}
                      aria-label={t("monitor_header_name")}
                      className="min-w-0 flex-1"
                      name={`headers.${index}.name`}
                      onChange={onField}
                      placeholder={t("monitor_header_name")}
                      value={row.name}
                      variant="token"
                    />
                    <Input
                      aria-invalid={errors[`${path}.value`] ? true : undefined}
                      aria-label={t("monitor_header_value")}
                      autoComplete="off"
                      className="min-w-0 flex-1"
                      dir="ltr"
                      name={`headers.${index}.value`}
                      onChange={onField}
                      placeholder={
                        row.storedName === undefined
                          ? t("monitor_header_value")
                          : kept
                      }
                      spellCheck={false}
                      type="password"
                      value={row.value}
                    />
                    <Button
                      aria-label={t("monitor_remove_header")}
                      data-index={index}
                      onClick={onRemoveHeader}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <XIcon />
                    </Button>
                  </div>
                  <Problem errors={errors} path={`${path}.name`} />
                  <Problem errors={errors} path={`${path}.value`} />
                </li>
              );
            })}
          </ul>
        ) : null}
        <Problem errors={errors} path="credentials.headers" />
      </Field>
      <Button
        className="self-start"
        data-slot="add-header"
        onClick={onAddHeader}
        type="button"
        variant="outline"
      >
        <PlusIcon />
        {t("monitor_add_header")}
      </Button>
    </>
  );
}

const captureLabels = {
  always: "monitor_capture_always",
  off: "monitor_capture_off",
  on_failure: "monitor_capture_on_failure",
} as const;

export function CaptureSection({
  draft,
  errors,
  onChoice,
  onField,
  onFlag,
}: SectionProps): ReactNode {
  const { locale, t } = useMessages();
  const https = isHttps(draft.url);
  const cost = t("monitor_capture_cost", {
    size: formatUnit(
      locale,
      captureBytesPerDay(draft.intervalMs) / 1_000_000,
      "megabyte"
    ),
  });
  return (
    <Section slot="capture" title={t("monitor_section_capture")}>
      <FlagField
        checked={https && draft.tlsExpiry}
        disabled={!https}
        hint={https ? undefined : t("monitor_field_tls_expiry_hint")}
        label={t("monitor_field_tls_expiry")}
        name="tlsExpiry"
        onFlag={onFlag}
      />
      {https && draft.tlsExpiry ? (
        <Field>
          <FieldLabel htmlFor="tlsExpiryDays">
            {t("monitor_field_tls_expiry_days")}
          </FieldLabel>
          <Input
            aria-invalid={errors["config.tlsExpiryDays"] ? true : undefined}
            className="max-w-36"
            id="tlsExpiryDays"
            inputMode="numeric"
            name="tlsExpiryDays"
            onChange={onField}
            unit={t("monitor_unit_days")}
            value={draft.tlsExpiryDays}
          />
          <Problem errors={errors} path="config.tlsExpiryDays" />
        </Field>
      ) : null}
      <ChoiceField
        choices={captureModes.map((value) => ({
          hint: value === "always" ? cost : undefined,
          label: t(captureLabels[value]),
          value,
        }))}
        label={t("monitor_field_capture_mode")}
        name="captureMode"
        onChoice={onChoice}
        value={draft.captureMode}
      />
      {/* What a capture holds, said only while the mode keeps one. */}
      {draft.captureMode === "off" ? null : (
        <FieldDescription>
          {t("monitor_field_capture_mode_hint")}
        </FieldDescription>
      )}
    </Section>
  );
}
