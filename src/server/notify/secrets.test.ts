import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { encrypt } from "@/server/boot/installkey.ts";
import {
  type ChannelDeclaration,
  emailDeclaration,
  webhookDeclaration,
} from "@/shared/schemas/channel.ts";
import {
  mergeValues,
  openSecrets,
  sealSecrets,
  splitValues,
} from "./secrets.ts";

const key = await scratchInstallKey();
const secret = `whsec_${new Uint8Array(32).fill(1).toBase64()}`;
const fresh = `whsec_${new Uint8Array(32).fill(2).toBase64()}`;
const generate = { secret: () => fresh };
const url = "https://hooks.example.test/raaqeb";

/** A declaration with a field in clear beside a typed secret and a generated one. */
const mixed: ChannelDeclaration = {
  ...webhookDeclaration,
  fields: [
    ...webhookDeclaration.fields,
    {
      kind: "text",
      label: "channel_field_url",
      name: "room",
      secret: false,
      value: z.string().trim().min(1),
    },
  ],
};

describe("a channel's values before they are stored", () => {
  test("a new channel keeps what was typed and gets its generated field made", () => {
    expect(
      mergeValues(webhookDeclaration, { url }, undefined, {
        generate,
        renew: false,
      })
    ).toEqual({ secret: fresh, url });
  });

  test("an edit that leaves a secret out keeps the stored one, and keeps the generated one", () => {
    expect(
      mergeValues(
        webhookDeclaration,
        {},
        { secret, url },
        { generate, renew: false }
      )
    ).toEqual({ secret, url });
  });

  test("a typed value replaces the stored one", () => {
    const other = "https://other.example.test/hook";
    expect(
      mergeValues(
        webhookDeclaration,
        { url: other },
        { secret, url },
        { generate, renew: false }
      )
    ).toEqual({ secret, url: other });
  });

  test("asking for a new generated value replaces it and nothing else", () => {
    expect(
      mergeValues(
        webhookDeclaration,
        {},
        { secret, url },
        { generate, renew: true }
      )
    ).toEqual({ secret: fresh, url });
  });

  test("a generated field is never taken from what was posted", () => {
    expect(
      mergeValues(
        webhookDeclaration,
        { secret: "whsec_posted", url },
        { secret, url },
        { generate, renew: false }
      )
    ).toEqual({ secret, url });
  });

  test("a missing value, or one that does not fit its field, stores nothing", () => {
    expect(
      mergeValues(webhookDeclaration, {}, undefined, {
        generate,
        renew: false,
      })
    ).toBeUndefined();
    expect(
      mergeValues(
        webhookDeclaration,
        { url: "ftp://example.test/" },
        { secret, url },
        { generate, renew: false }
      )
    ).toBeUndefined();
  });

  test("a value typed empty counts as left out", () => {
    expect(
      mergeValues(
        webhookDeclaration,
        { url: "" },
        { secret, url },
        { generate, renew: false }
      )
    ).toEqual({ secret, url });
  });

  test("a field in clear is required on every save, stored or not", () => {
    expect(
      mergeValues(
        mixed,
        { url },
        { room: "ops", secret, url },
        { generate, renew: false }
      )
    ).toBeUndefined();
  });

  test("a name the type does not declare is dropped", () => {
    expect(
      mergeValues(webhookDeclaration, { extra: "x", url }, undefined, {
        generate,
        renew: false,
      })
    ).toEqual({ secret: fresh, url });
  });

  test("the secret fields are split from those stored in clear", () => {
    expect(splitValues(mixed, { room: "ops", secret, url })).toEqual({
      config: { room: "ops" },
      secrets: { secret, url },
    });
  });
});

describe("a channel's secrets at rest", () => {
  test("the ciphertext holds no secret in clear and opens back to them", async () => {
    const sealed = await sealSecrets(key, { secret, url });
    expect(sealed).toBeDefined();
    expect(sealed).not.toContain("hooks.example.test");
    expect(sealed).not.toContain("whsec_");
    expect(await openSecrets(key, sealed ?? "")).toEqual({ secret, url });
  });

  test("no secrets seal to nothing", async () => {
    expect(await sealSecrets(key, {})).toBeUndefined();
  });

  test("another install's key opens nothing, and neither does a ciphertext of something else", async () => {
    const sealed = (await sealSecrets(key, { url })) ?? "";
    expect(
      await openSecrets(await scratchInstallKey(), sealed)
    ).toBeUndefined();
    expect(
      await openSecrets(key, await encrypt(key, "[1, 2]"))
    ).toBeUndefined();
    expect(
      await openSecrets(key, await encrypt(key, '{"url": 5}'))
    ).toBeUndefined();
  });
});

const smtpTyped = {
  from: "alerts@example.test",
  host: "smtp.example.test",
  port: "587",
  security: "starttls",
  to: "ops@example.test",
};
const keep = { generate: {}, renew: false };

describe("an email channel's values before they are stored", () => {
  test("only the declared fields are stored, never a value left from a sending method Raaqeb no longer has", () => {
    expect(
      mergeValues(
        emailDeclaration,
        {
          ...smtpTyped,
          providerApiKey: "key_left_in_the_form",
          transport: "provider",
        },
        undefined,
        keep
      )
    ).toEqual(smtpTyped);
  });

  test("an optional user name left empty is not stored", () => {
    expect(
      mergeValues(
        emailDeclaration,
        { ...smtpTyped, username: "" },
        undefined,
        keep
      )
    ).toEqual(smtpTyped);
  });

  test("a stored password is kept while the user name stays, and dropped once it goes", () => {
    const stored = { ...smtpTyped, password: "s3cret", username: "alerts" };
    expect(
      mergeValues(
        emailDeclaration,
        { ...smtpTyped, username: "alerts" },
        stored,
        keep
      )
    ).toEqual(stored);
    expect(mergeValues(emailDeclaration, smtpTyped, stored, keep)).toEqual(
      smtpTyped
    );
  });

  test("a channel stored with a provider's key is saved with the SMTP fields alone, the key dropped", () => {
    const stored = {
      from: "alerts@example.test",
      providerApiKey: "key_1",
      to: "ops@example.test",
      transport: "provider",
    };
    expect(mergeValues(emailDeclaration, smtpTyped, stored, keep)).toEqual(
      smtpTyped
    );
  });

  test("the password is sealed, the rest stays in clear", () => {
    expect(
      splitValues(emailDeclaration, {
        ...smtpTyped,
        password: "s3cret",
        username: "alerts",
      })
    ).toEqual({
      config: { ...smtpTyped, username: "alerts" },
      secrets: { password: "s3cret" },
    });
  });
});
