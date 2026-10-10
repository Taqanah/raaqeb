import { describe, expect, test } from "bun:test";
import type { ChannelForm } from "@/shared/schemas/channel.ts";
import {
  type ChannelDraft,
  channelDraftOf,
  channelInputOf,
  withChannelField,
} from "./draft.ts";

const stored: ChannelForm = {
  channel: {
    appliesToNew: false,
    config: {},
    createdAt: 1,
    id: "c1",
    locale: "en",
    name: "Ops",
    type: "webhook",
    updatedAt: 2,
  },
  generated: { secret: "whsec_x" },
  kept: ["url"],
  preview: [],
  recent: [],
  summary: "hooks.example.test",
};

const typed = (fields: Partial<ChannelDraft>): ChannelDraft => ({
  ...channelDraftOf(undefined, "webhook"),
  name: "فريق التشغيل",
  ...fields,
});

describe("a channel's draft", () => {
  test("a new channel starts empty, follows the install language and applies to new monitors", () => {
    expect(channelDraftOf(undefined, "webhook")).toEqual({
      appliesToNew: true,
      locale: "",
      name: "",
      renewGenerated: false,
      type: "webhook",
      values: { url: "" },
    });
  });

  test("a stored channel starts from its fields, with its typed secrets empty", () => {
    expect(channelDraftOf(stored, "webhook")).toEqual({
      appliesToNew: false,
      locale: "en",
      name: "Ops",
      renewGenerated: false,
      type: "webhook",
      values: { url: "" },
    });
  });
});

describe("what the channel form posts", () => {
  test("the typed values, the flag and the language; a generated field is never posted", () => {
    const parsed = channelInputOf(
      typed({
        locale: "ar",
        values: { url: " https://hooks.example.test/x " },
      }),
      []
    );
    expect(parsed).toEqual({
      input: {
        appliesToNew: true,
        locale: "ar",
        name: "فريق التشغيل",
        type: "webhook",
        values: { url: "https://hooks.example.test/x" },
      },
      ok: true,
    });
  });

  test("following the install language posts no language", () => {
    const parsed = channelInputOf(
      typed({ values: { url: "https://hooks.example.test/x" } }),
      []
    );
    expect(parsed.ok && parsed.input.locale).toBeUndefined();
  });

  test("an empty secret with a stored value keeps it, and posts nothing for it", () => {
    const parsed = channelInputOf(channelDraftOf(stored, "webhook"), ["url"]);
    expect(parsed.ok && parsed.input.values).toEqual({});
  });

  test("a refused field is named with its catalog message", () => {
    expect(channelInputOf(typed({ name: " " }), [])).toEqual({
      errors: {
        name: "channel_refused_name",
        url: "channel_refused_required",
      },
      ok: false,
    });
    expect(
      channelInputOf(typed({ values: { url: "ftp://example.test/" } }), [])
    ).toEqual({ errors: { url: "channel_refused_url" }, ok: false });
    expect(
      channelInputOf(
        typed({ name: "x".repeat(81), values: { url: "https://h.test/" } }),
        []
      )
    ).toEqual({ errors: { name: "channel_refused_name" }, ok: false });
  });

  test("an input changes the field it names, and nothing else", () => {
    const draft = typed({});
    expect(withChannelField(draft, "name", "Night").name).toBe("Night");
    expect(withChannelField(draft, "locale", "en").locale).toBe("en");
    expect(withChannelField(draft, "locale", "").locale).toBe("");
    expect(withChannelField(draft, "locale", "fr")).toEqual(draft);
    expect(withChannelField(draft, "url", "https://h.test/").values).toEqual({
      url: "https://h.test/",
    });
    expect(withChannelField(draft, "secret", "whsec_typed")).toEqual(draft);
    expect(withChannelField(draft, "nothing", "x")).toEqual(draft);
  });
});

const email = (values: Readonly<Record<string, string>>): ChannelDraft => ({
  ...channelDraftOf(undefined, "email"),
  name: "بريد الفريق",
  values: { ...channelDraftOf(undefined, "email").values, ...values },
});

const smtp = {
  from: "Raaqeb <alerts@example.test>",
  host: "smtp.example.test",
  to: "ops@example.test, oncall@example.test",
};

describe("an email channel's draft", () => {
  test("a new email channel starts on STARTTLS on port 587, every other field empty", () => {
    expect(channelDraftOf(undefined, "email").values).toEqual({
      from: "",
      host: "",
      password: "",
      port: "587",
      security: "starttls",
      to: "",
      username: "",
    });
  });

  test("SMTP with no user name posts no password and needs none", () => {
    expect(channelInputOf(email(smtp), [])).toEqual({
      input: {
        appliesToNew: true,
        name: "بريد الفريق",
        type: "email",
        values: {
          from: "Raaqeb <alerts@example.test>",
          host: "smtp.example.test",
          port: "587",
          security: "starttls",
          to: "ops@example.test, oncall@example.test",
        },
      },
      ok: true,
    });
  });

  test("a user name asks for its password, which a stored one keeps", () => {
    const withUser = email({ ...smtp, username: "alerts" });
    expect(channelInputOf(withUser, [])).toEqual({
      errors: { password: "channel_refused_required" },
      ok: false,
    });
    const parsed = channelInputOf(withUser, ["password"]);
    expect(parsed.ok && parsed.input.values.password).toBeUndefined();
    expect(parsed.ok && parsed.input.values.username).toBe("alerts");
  });

  test("SMTP without security posts no user name or password, whatever was typed", () => {
    const parsed = channelInputOf(
      email({
        ...smtp,
        password: "s3cret",
        security: "none",
        username: "alerts",
      }),
      []
    );
    expect(
      parsed.ok &&
        Object.keys(parsed.input.values).sort((a, b) => a.localeCompare(b))
    ).toEqual(["from", "host", "port", "security", "to"]);
  });

  test("each refused email field is named with its own catalog message", () => {
    expect(
      channelInputOf(
        email({ from: "alerts", host: "smtp://x", port: "0", to: "nobody" }),
        []
      )
    ).toEqual({
      errors: {
        from: "channel_refused_from",
        host: "channel_refused_host",
        port: "channel_refused_port",
        to: "channel_refused_to",
      },
      ok: false,
    });
  });

  test("the security is a field an input changes", () => {
    const draft = email({});
    expect(withChannelField(draft, "security", "tls").values.security).toBe(
      "tls"
    );
  });

  test("digits typed in Arabic become Western digits, except in a secret", () => {
    const draft = email({});
    expect(withChannelField(draft, "port", "٥٨٧").values.port).toBe("587");
    expect(withChannelField(draft, "password", "كلمة٣").values.password).toBe(
      "كلمة٣"
    );
  });

  test("a channel stored with a provider's key opens with the SMTP fields at their initial values, the key not kept", () => {
    const provider: ChannelForm = {
      ...stored,
      channel: {
        ...stored.channel,
        config: {
          from: "alerts@example.test",
          to: "ops@example.test",
          transport: "provider",
        },
        type: "email",
      },
      kept: ["providerApiKey"],
    };
    const draft = channelDraftOf(provider, "email");
    expect(draft.values.security).toBe("starttls");
    expect(draft.values.port).toBe("587");
    expect(draft.values).not.toHaveProperty("transport");
    expect(draft.values).not.toHaveProperty("providerApiKey");
  });
});

describe("a chat channel's draft", () => {
  test("a new ntfy channel starts at the public server, its topic and token empty", () => {
    expect(channelDraftOf(undefined, "ntfy").values).toEqual({
      server: "https://ntfy.sh",
      token: "",
      topic: "",
    });
  });

  test("an ntfy channel with no access token posts none, and one with no topic is refused", () => {
    const ntfy = (values: Record<string, string>): ChannelDraft => ({
      ...channelDraftOf(undefined, "ntfy"),
      name: "هاتف المناوب",
      values: { server: "https://ntfy.sh", token: "", topic: "", ...values },
    });
    const parsed = channelInputOf(ntfy({ topic: "raaqeb-alerts" }), []);
    expect(parsed.ok && parsed.input.values).toEqual({
      server: "https://ntfy.sh",
      topic: "raaqeb-alerts",
    });
    expect(channelInputOf(ntfy({}), [])).toEqual({
      errors: { topic: "channel_refused_required" },
      ok: false,
    });
  });

  test("a Telegram channel posts its token and chat ID, and a chat ID typed in Arabic digits becomes Western", () => {
    const draft = withChannelField(
      withChannelField(
        {
          ...channelDraftOf(undefined, "telegram"),
          name: "مجموعة التشغيل",
        },
        "botToken",
        "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
      ),
      "chatId",
      "-١٠٠١٢٣٤"
    );
    const parsed = channelInputOf(draft, []);
    expect(parsed.ok && parsed.input.values).toEqual({
      botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      chatId: "-1001234",
    });
  });

  test("each refused chat field is named with its own catalog message", () => {
    const parsed = channelInputOf(
      {
        ...channelDraftOf(undefined, "telegram"),
        name: "Ops",
        values: { botToken: "nope", chatId: "ops" },
      },
      []
    );
    expect(parsed).toEqual({
      errors: {
        botToken: "channel_refused_bot_token",
        chatId: "channel_refused_chat_id",
      },
      ok: false,
    });
  });
});
