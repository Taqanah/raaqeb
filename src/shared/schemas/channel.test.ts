import { describe, expect, test } from "bun:test";
import {
  type ChannelDeclaration,
  type ChannelValues,
  channelDeclarations,
  channelInputSchema,
  channelTypes,
  channelUrlMaxLength,
  discordDeclaration,
  emailDeclaration,
  fieldsFor,
  hintFor,
  ntfyDeclaration,
  recipientsOf,
  senderOf,
  slackDeclaration,
  telegramDeclaration,
  webhookDeclaration,
} from "./channel.ts";

const field = (name: string) => {
  const found = webhookDeclaration.fields.find((each) => each.name === name);
  if (!found) {
    throw new Error(`the webhook declares no ${name}`);
  }
  return found;
};

describe("a channel type's declaration", () => {
  test("every channel type has a declaration of its own type", () => {
    for (const type of channelTypes) {
      expect(channelDeclarations[type].type).toBe(type);
    }
  });

  test("the webhook's URL is a secret the operator types, and its signing secret is a secret Raaqeb generates", () => {
    expect(field("url")).toMatchObject({ kind: "url", secret: true });
    expect(field("secret")).toMatchObject({ kind: "generated", secret: true });
  });

  test("every channel type writes its text in the channel language but the webhook, whose body is machine values", () => {
    expect(
      channelTypes.filter((type) => channelDeclarations[type].localized)
    ).toEqual(channelTypes.filter((type) => type !== "webhook"));
  });

  test("the webhook's URL is http or https and no longer than the cap", () => {
    const url = field("url").value;
    expect(
      url.safeParse("https://hooks.example.test/raaqeb?token=abc").success
    ).toBe(true);
    expect(url.safeParse("http://10.0.0.5:8080/hook").success).toBe(true);
    expect(url.safeParse("ftp://example.test/hook").success).toBe(false);
    // Port 0 reaches nothing.
    expect(url.safeParse("http://127.0.0.1:0/hook").success).toBe(false);
    expect(url.safeParse("not a url").success).toBe(false);
    const long = `https://example.test/${"a".repeat(channelUrlMaxLength)}`;
    expect(url.safeParse(long).success).toBe(false);
  });

  test("a signing secret is whsec_ and the base64 of 32 bytes", () => {
    const secret = field("secret").value;
    const bytes = new Uint8Array(32).fill(7);
    expect(secret.safeParse(`whsec_${bytes.toBase64()}`).success).toBe(true);
    expect(secret.safeParse(bytes.toBase64()).success).toBe(false);
    expect(
      secret.safeParse(`whsec_${new Uint8Array(24).toBase64()}`).success
    ).toBe(false);
  });

  test("the list shows a webhook by its URL's host, never its path or query", () => {
    expect(
      webhookDeclaration.summary({
        secret: "whsec_x",
        url: "https://hooks.example.test:8443/services/T0/B0/secret?x=1",
      })
    ).toBe("hooks.example.test:8443");
    expect(webhookDeclaration.summary({})).toBe("");
  });
});

describe("what a channel form posts", () => {
  test("a name is trimmed and required, and the language may be left to the install", () => {
    const parsed = channelInputSchema.safeParse({
      appliesToNew: true,
      name: "  فريق التشغيل  ",
      type: "webhook",
      values: { url: "https://example.test/hook" },
    });
    expect(parsed.success && parsed.data.name).toBe("فريق التشغيل");
    expect(parsed.success && parsed.data.locale).toBeUndefined();
    expect(
      channelInputSchema.safeParse({
        appliesToNew: false,
        name: "   ",
        type: "webhook",
        values: {},
      }).success
    ).toBe(false);
  });

  test("a type Raaqeb does not ship is refused", () => {
    expect(
      channelInputSchema.safeParse({
        appliesToNew: false,
        name: "Teams",
        type: "teams",
        values: {},
      }).success
    ).toBe(false);
  });
});

const emailField = (name: string) => {
  const found = emailDeclaration.fields.find((each) => each.name === name);
  if (!found) {
    throw new Error(`the email channel declares no ${name}`);
  }
  return found;
};

const fits = (name: string, value: string): boolean =>
  emailField(name).value.safeParse(value).success;

const appliesTo = (values: ChannelValues): string[] =>
  fieldsFor(emailDeclaration, values).map((each) => each.name);

describe("the email channel's declaration", () => {
  test("the password is the only secret", () => {
    const secrets = emailDeclaration.fields
      .filter((each) => each.secret)
      .map((each) => each.name);
    expect(secrets).toEqual(["password"]);
  });

  test("a new email channel starts on STARTTLS on port 587", () => {
    expect(emailField("security").initial).toBe("starttls");
    expect(emailField("port").initial).toBe("587");
  });

  test("SMTP over a protected connection asks for its server, its security, its port and an optional user name", () => {
    expect(appliesTo({ security: "starttls", username: "" })).toEqual([
      "from",
      "to",
      "host",
      "security",
      "port",
      "username",
    ]);
    expect(emailField("username").optional).toBe(true);
  });

  test("a user name typed over a protected connection asks for its password", () => {
    expect(appliesTo({ security: "tls", username: "alerts" })).toContain(
      "password"
    );
    expect(appliesTo({ security: "tls", username: "  " })).not.toContain(
      "password"
    );
  });

  test("SMTP without security never asks for a user name or a password, so AUTH never crosses a plain connection", () => {
    const names = appliesTo({
      security: "none",
      username: "alerts",
    });
    expect(names).not.toContain("username");
    expect(names).not.toContain("password");
  });

  test("the email channel sends over SMTP alone, with no sending method to choose", () => {
    expect(emailDeclaration.fields.map((each) => each.name)).toEqual([
      "from",
      "to",
      "host",
      "security",
      "port",
      "username",
      "password",
    ]);
  });

  test("a sender is an address, or a name and the address in angle brackets", () => {
    expect(senderOf("alerts@example.test")).toEqual({
      address: "alerts@example.test",
      name: undefined,
    });
    expect(senderOf("راقب <alerts@example.test>")).toEqual({
      address: "alerts@example.test",
      name: "راقب",
    });
    expect(senderOf("  Raaqeb Alerts   <alerts@example.test>  ")).toEqual({
      address: "alerts@example.test",
      name: "Raaqeb Alerts",
    });
    for (const refused of [
      "",
      "alerts",
      "<alerts@example.test>",
      "Raaqeb <alerts>",
      "a, b <alerts@example.test>",
      '"Raaqeb" <alerts@example.test>',
      "Raaqeb <alerts@example.test> x",
      "Evil\nBcc: v@example.test <alerts@example.test>",
      "Evil\r <alerts@example.test>",
    ]) {
      expect(senderOf(refused)).toBeUndefined();
      expect(fits("from", refused)).toBe(false);
    }
  });

  test("recipients split on the Latin or the Arabic comma, blanks dropped", () => {
    expect(
      recipientsOf(" a@example.test ،b@example.test,, c@example.test ")
    ).toEqual(["a@example.test", "b@example.test", "c@example.test"]);
  });

  test("an email channel writes to one to ten valid addresses", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `u${i}@example.test`);
    expect(fits("to", "ops@example.test")).toBe(true);
    expect(fits("to", ten.join(", "))).toBe(true);
    expect(fits("to", [...ten, "u10@example.test"].join(", "))).toBe(false);
    expect(fits("to", ", ,")).toBe(false);
    expect(fits("to", "ops@example.test, not-an-address")).toBe(false);
  });

  test("the server is a host name or an IP address, never a URL or a host with its port", () => {
    expect(fits("host", "smtp.example.test")).toBe(true);
    expect(fits("host", "10.0.0.25")).toBe(true);
    expect(fits("host", "2001:db8::25")).toBe(true);
    expect(fits("host", "smtp://smtp.example.test")).toBe(false);
    expect(fits("host", "smtp.example.test:587")).toBe(false);
  });

  test("a port runs from 1 to 65535 in digits", () => {
    expect(fits("port", "1")).toBe(true);
    expect(fits("port", "65535")).toBe(true);
    expect(fits("port", "0")).toBe(false);
    expect(fits("port", "65536")).toBe(false);
    expect(fits("port", "58x")).toBe(false);
  });

  test("the security is STARTTLS, TLS or none", () => {
    expect(fits("security", "none")).toBe(true);
    expect(fits("security", "ssl")).toBe(false);
  });

  test("the line under the security describes the security selected, so STARTTLS and TLS never read as unprotected", () => {
    const security = emailField("security");
    expect(hintFor(security, "starttls")).toBe(
      "channel_security_starttls_hint"
    );
    expect(hintFor(security, "tls")).toBe("channel_security_tls_hint");
    expect(hintFor(security, "none")).toBe("channel_security_none_hint");
  });

  test("a field or a choice with no line of its own keeps the field's one line, whatever its value", () => {
    expect(hintFor(emailField("port"), "465")).toBe("channel_field_port_hint");
    expect(
      hintFor(
        {
          ...emailField("security"),
          hint: "channel_field_port_hint",
          options: [{ label: "channel_security_tls", value: "tls" }],
        },
        "tls"
      )
    ).toBe("channel_field_port_hint");
    expect(hintFor(emailField("host"), "smtp.example.test")).toBeUndefined();
  });

  test("the list shows an email channel by its recipients, never a secret", () => {
    expect(
      emailDeclaration.summary({
        from: "alerts@example.test",
        password: "smtp-secret",
        to: "a@example.test،b@example.test",
      })
    ).toBe("a@example.test, b@example.test");
  });
});

/** A declared field of a chat channel, or a throw naming what is missing. */
const declared = (declaration: ChannelDeclaration, name: string) => {
  const found = declaration.fields.find((each) => each.name === name);
  if (!found) {
    throw new Error(`the ${declaration.type} channel declares no ${name}`);
  }
  return found;
};

const accepts = (
  declaration: ChannelDeclaration,
  name: string,
  value: string
): boolean => declared(declaration, name).value.safeParse(value).success;

describe("the chat channels' declarations", () => {
  test("Slack and Discord each take one URL, typed and sealed, since it carries the token", () => {
    for (const declaration of [slackDeclaration, discordDeclaration]) {
      expect(declaration.fields.map((each) => each.name)).toEqual(["url"]);
      expect(declared(declaration, "url")).toMatchObject({
        kind: "url",
        secret: true,
      });
    }
  });

  test("a Slack or Discord URL is any http or https URL, so a compatible receiver works too", () => {
    for (const declaration of [slackDeclaration, discordDeclaration]) {
      expect(
        accepts(
          declaration,
          "url",
          "https://hooks.slack.com/services/T0/B0/token"
        )
      ).toBe(true);
      expect(
        accepts(
          declaration,
          "url",
          "https://discord.com/api/webhooks/1234/token"
        )
      ).toBe(true);
      expect(
        accepts(declaration, "url", "http://mattermost.lan:8065/hooks/abc")
      ).toBe(true);
      expect(accepts(declaration, "url", "hooks.slack.com/services/T0")).toBe(
        false
      );
      expect(accepts(declaration, "url", "ftp://example.test/hook")).toBe(
        false
      );
    }
  });

  test("the list shows Slack and Discord by the URL's host, never its token", () => {
    expect(
      slackDeclaration.summary({
        url: "https://hooks.slack.com/services/T0/B0/token",
      })
    ).toBe("hooks.slack.com");
    expect(
      discordDeclaration.summary({
        url: "https://discord.com/api/webhooks/1234/token",
      })
    ).toBe("discord.com");
  });

  test("Telegram seals the bot token and keeps the chat ID in clear", () => {
    expect(telegramDeclaration.fields.map((each) => each.name)).toEqual([
      "botToken",
      "chatId",
    ]);
    expect(declared(telegramDeclaration, "botToken")).toMatchObject({
      kind: "text",
      refusal: "channel_refused_bot_token",
      secret: true,
    });
    expect(declared(telegramDeclaration, "chatId")).toMatchObject({
      kind: "text",
      refusal: "channel_refused_chat_id",
      secret: false,
    });
  });

  test("a bot token is the bot's number, a colon and its secret", () => {
    const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
    expect(accepts(telegramDeclaration, "botToken", token)).toBe(true);
    expect(accepts(telegramDeclaration, "botToken", "123456789")).toBe(false);
    expect(accepts(telegramDeclaration, "botToken", "bot:AAHdqTcvCH1v")).toBe(
      false
    );
    expect(accepts(telegramDeclaration, "botToken", `${token} `)).toBe(false);
    expect(accepts(telegramDeclaration, "botToken", "123456789:AAHdqTcv")).toBe(
      false
    );
  });

  test("a chat ID is a number, negative for a group, or a public channel's @name", () => {
    for (const id of ["123456789", "-4567", "-1001234567890", "@raaqeb_ops"]) {
      expect(accepts(telegramDeclaration, "chatId", id)).toBe(true);
    }
    expect(accepts(telegramDeclaration, "chatId", "@abcde")).toBe(true);
    expect(accepts(telegramDeclaration, "chatId", `@${"a".repeat(32)}`)).toBe(
      true
    );
    expect(accepts(telegramDeclaration, "chatId", `@${"a".repeat(33)}`)).toBe(
      false
    );
    for (const id of ["", "raaqeb_ops", "@abcd", "@1abcde", "12 34", "+123"]) {
      expect(accepts(telegramDeclaration, "chatId", id)).toBe(false);
    }
  });

  test("the list shows a Telegram channel by its chat ID, never its token", () => {
    expect(
      telegramDeclaration.summary({
        botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
        chatId: "-1001234567890",
      })
    ).toBe("-1001234567890");
  });

  test("ntfy keeps its server in clear, starting at the public one, and seals the topic and the optional access token", () => {
    expect(ntfyDeclaration.fields.map((each) => each.name)).toEqual([
      "server",
      "topic",
      "token",
    ]);
    expect(declared(ntfyDeclaration, "server")).toMatchObject({
      initial: "https://ntfy.sh",
      kind: "url",
      secret: false,
    });
    expect(declared(ntfyDeclaration, "server").refusal).toBe(
      "channel_refused_server"
    );
    expect(declared(ntfyDeclaration, "topic")).toMatchObject({
      refusal: "channel_refused_topic",
      secret: true,
    });
    expect(declared(ntfyDeclaration, "topic").optional).toBeUndefined();
    // The operator types the same topic into the phone app, so it is shown while typed (the screenshots).
    expect(declared(ntfyDeclaration, "topic").shown).toBe(true);
    expect(declared(ntfyDeclaration, "token").shown).toBeUndefined();
    expect(declared(ntfyDeclaration, "token").refusal).toBe(
      "channel_refused_access_token"
    );
    expect(declared(ntfyDeclaration, "token")).toMatchObject({
      optional: true,
      secret: true,
    });
  });

  test("an ntfy topic is 1 to 64 Latin letters, digits, dashes and underscores", () => {
    for (const topic of ["raaqeb-alerts", "ops_2026", "a", "x".repeat(64)]) {
      expect(accepts(ntfyDeclaration, "topic", topic)).toBe(true);
    }
    for (const topic of [
      "",
      "x".repeat(65),
      "ops alerts",
      "ops/alerts",
      "تنبيهات",
    ]) {
      expect(accepts(ntfyDeclaration, "topic", topic)).toBe(false);
    }
  });

  test("an ntfy server is an address with no path, so a topic typed into it is refused", () => {
    for (const server of [
      "https://ntfy.sh",
      "https://ntfy.sh/",
      "http://10.0.0.5:8080",
    ]) {
      expect(accepts(ntfyDeclaration, "server", server)).toBe(true);
    }
    for (const server of [
      "https://ntfy.sh/raaqeb-alerts",
      "https://ntfy.example.test/ntfy/",
      "https://ntfy.sh/?x=1",
      // The server is kept in clear, so a login in its address is refused.
      "https://raaqeb:secret@ntfy.example.test",
      "ntfy.sh",
    ]) {
      expect(accepts(ntfyDeclaration, "server", server)).toBe(false);
    }
  });

  test("the list shows an ntfy channel by its server's host, never its topic", () => {
    expect(
      ntfyDeclaration.summary({
        server: "https://ntfy.example.test",
        token: "tk_secret",
        topic: "raaqeb-alerts",
      })
    ).toBe("ntfy.example.test");
  });
});
