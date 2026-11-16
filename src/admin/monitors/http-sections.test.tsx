import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { noCredentials } from "@/shared/schemas/credentials.ts";
import type { CaptureMode } from "@/shared/schemas/monitor.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { draftOf, type MonitorDraft } from "./draft.ts";
import {
  CaptureSection,
  RequestSection,
  TlsSection,
} from "./http-sections.tsx";

const noop = () => undefined;
// An input's attributes in either order.
const passwordInput =
  /name="proxyPassword"[^>]*type="password"|type="password"[^>]*name="proxyPassword"/;
const passphraseInput =
  /name="clientPassphrase"[^>]*type="password"|type="password"[^>]*name="clientPassphrase"/;
const i18n = createMessages("en", en);
const whatACaptureHolds = i18n._("monitor_field_capture_mode_hint");

function captureSection(captureMode: CaptureMode): string {
  return renderToString(
    <MessagesProvider i18n={i18n}>
      <CaptureSection
        draft={{ ...draftOf(undefined, noCredentials), captureMode }}
        errors={{}}
        onChoice={noop}
        onField={noop}
        onFlag={noop}
      />
    </MessagesProvider>
  );
}

describe("the line under the capture mode", () => {
  test("says what a capture holds while the mode keeps one", () => {
    expect(captureSection("on_failure")).toContain(whatACaptureHolds);
    expect(captureSection("always")).toContain(whatACaptureHolds);
  });

  test("says nothing of a capture's contents while capture is off, since none is kept", () => {
    expect(captureSection("off")).not.toContain(whatACaptureHolds);
  });
});

function requestSection(fields: Partial<MonitorDraft>): string {
  return renderToString(
    <MessagesProvider i18n={i18n}>
      <RequestSection
        draft={{ ...draftOf(undefined, noCredentials), ...fields }}
        errors={{}}
        onAddAssertion={noop}
        onAddHeader={noop}
        onChoice={noop}
        onField={noop}
        onFlag={noop}
        onRemoveAssertion={noop}
        onRemoveHeader={noop}
      />
    </MessagesProvider>
  );
}

const typedAddress = { proxy: "http://proxy.example.test:3128" };

describe("the request section's proxy", () => {
  test("asks for the address with the line that says it overrides the install's environment, and for no user name or password yet", () => {
    const html = requestSection({});
    expect(html).toContain('name="proxy"');
    expect(html).toContain(
      i18n._("monitor_field_proxy_hint").replaceAll("'", "&#x27;")
    );
    expect(html).not.toContain('name="proxyUser"');
    expect(html).not.toContain('name="proxyPassword"');
  });

  test("asks for the user name and the password once an address is typed, the password hidden", () => {
    const html = requestSection(typedAddress);
    expect(html).toContain('name="proxyUser"');
    expect(html).toContain('name="proxyPassword"');
    expect(html).toMatch(passwordInput);
  });

  test("says a stored proxy password is kept, and says nothing of one when none is stored", () => {
    const kept = `placeholder="${i18n._("monitor_secret_kept")}"`;
    expect(
      requestSection({ ...typedAddress, storedProxyAuth: true })
    ).toContain(kept);
    expect(requestSection(typedAddress)).not.toContain(kept);
  });
});

function tlsSection(
  fields: Partial<MonitorDraft>,
  errors: Record<string, { id: "monitor_error_pem_key" }> = {}
): string {
  return renderToString(
    <MessagesProvider i18n={i18n}>
      <TlsSection
        draft={{ ...draftOf(undefined, noCredentials), ...fields }}
        errors={errors}
        onChoice={noop}
        onField={noop}
        onFlag={noop}
      />
    </MessagesProvider>
  );
}

const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";

describe("the TLS section", () => {
  test("asks for the CA certificates and the client certificate, and for no key or passphrase until a certificate is typed", () => {
    const html = tlsSection({});
    expect(html).toContain('name="caCertificates"');
    expect(html).toContain('name="clientCertificate"');
    expect(html).not.toContain('name="clientKey"');
    expect(html).not.toContain('name="clientPassphrase"');
  });

  test("asks for the key and a passphrase hidden as a password once a certificate is typed", () => {
    const html = tlsSection({ clientCertificate: pem });
    expect(html).toContain('name="clientKey"');
    expect(html).toMatch(passphraseInput);
  });

  test("shows the certificates as they were typed, left to right", () => {
    const html = tlsSection({ caCertificates: pem, clientCertificate: pem });
    expect(html).toContain("AAAA");
    expect(html.match(/dir="ltr"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("says a stored key is kept when its fields stay empty", () => {
    const kept = i18n._("monitor_secret_kept");
    const stored = tlsSection({
      clientCertificate: pem,
      storedClientKey: true,
    });
    expect(stored.split(kept)).toHaveLength(3);
    const fresh = tlsSection({ clientCertificate: pem });
    expect(fresh).not.toContain(kept);
  });

  test("says the passphrase is kept only while the key is, not once a new key is typed, which brings its own passphrase or none", () => {
    const kept = i18n._("monitor_secret_kept");
    const keptKey = tlsSection({
      clientCertificate: pem,
      storedClientKey: true,
    });
    expect(keptKey.split(kept)).toHaveLength(3);
    const newKey = tlsSection({
      clientCertificate: pem,
      clientKey: "-----BEGIN PRIVATE KEY-----",
      storedClientKey: true,
    });
    // The key field's own placeholder stays, shown only while it is empty; the passphrase's goes.
    expect(newKey.split(kept)).toHaveLength(2);
  });

  test("marks the key field and words its refusal when the draft's key is refused", () => {
    const html = tlsSection(
      { clientCertificate: pem },
      { "credentials.clientKey.key": { id: "monitor_error_pem_key" } }
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(
      i18n._("monitor_error_pem_key").replaceAll("'", "&#x27;")
    );
  });
});

const secretInput =
  /name="oauthClientSecret"[^>]*type="password"|type="password"[^>]*name="oauthClientSecret"/;

describe("the request section's OAuth 2.0 client credentials", () => {
  test("is one of the authentication choices, and asks for none of its fields until chosen", () => {
    const html = requestSection({});
    expect(html).toContain(i18n._("monitor_auth_oauth2"));
    expect(html).not.toContain('name="oauthTokenUrl"');
  });

  test("asks for the token URL, the client ID, a hidden secret, the scope and the audience once chosen, and says which way the client authenticates", () => {
    const html = requestSection({ auth: "oauth2" });
    for (const name of [
      "oauthTokenUrl",
      "oauthClientId",
      "oauthClientSecret",
      "oauthScope",
      "oauthAudience",
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toMatch(secretInput);
    expect(html).toContain(i18n._("monitor_oauth_method_basic"));
    expect(html).toContain(i18n._("monitor_oauth_method_body"));
  });

  test("each way the client authenticates carries its own line, true whichever is selected", () => {
    for (const oauthMethod of ["basic", "body"] as const) {
      const html = requestSection({ auth: "oauth2", oauthMethod });
      expect(html).toContain(i18n._("monitor_oauth_method_basic_hint"));
      expect(html).toContain(i18n._("monitor_oauth_method_body_hint"));
    }
  });

  test("says a stored secret is kept, and nothing of one when none is stored", () => {
    const kept = `placeholder="${i18n._("monitor_secret_kept")}"`;
    expect(requestSection({ auth: "oauth2", storedAuth: "oauth2" })).toContain(
      kept
    );
    expect(requestSection({ auth: "oauth2" })).not.toContain(kept);
    // A stored bearer token's secret is not an OAuth secret to keep.
    expect(
      requestSection({ auth: "oauth2", storedAuth: "bearer" })
    ).not.toContain(kept);
  });
});
