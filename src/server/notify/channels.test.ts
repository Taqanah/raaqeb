import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { encrypt } from "@/server/boot/installkey.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { calendar, timeZone } from "@/server/settings/clock.ts";
import { installLanguage } from "@/server/settings/language.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import {
  type ChannelInput,
  signingSecretShape,
} from "@/shared/schemas/channel.ts";
import type { DeliverIo } from "./channel.ts";
import {
  createChannel,
  deleteChannel,
  editChannel,
  listChannels,
  readChannelForm,
  recentShown,
  sendTest,
} from "./channels.ts";
import { bodyText, fakeSmtp, parse } from "./fixture.ts";
import { openSecrets } from "./secrets.ts";
import { signWebhook } from "./webhook.ts";

const key = await scratchInstallKey();

let open:
  | {
      storage: Storage;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = {
    cleanup: scratch.cleanup,
    location: scratch.location,
    storage: opened.storage,
  };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

/** A receiver that answers 200 on /ok and 500 elsewhere, and keeps what it got. */
const received: { body: string; headers: Headers; path: string }[] = [];
const receiver: Bun.Server<undefined> = Bun.serve({
  fetch: async (request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    received.push({
      body: await request.text(),
      headers: request.headers,
      path: pathname,
    });
    return new Response(null, { status: pathname === "/ok" ? 200 : 500 });
  },
  port: 0,
});
afterAll(() => receiver.stop(true));
const origin = `http://127.0.0.1:${receiver.port}`;
const live: DeliverIo = { fetch, now: Date.now };

const token = "T0kenInThePath9f3a";
const url = `https://hooks.example.test/services/${token}`;

const ops: ChannelInput = {
  appliesToNew: true,
  name: "فريق التشغيل",
  type: "webhook",
  values: { url },
};

async function created(store: Storage, input: ChannelInput = ops) {
  const result = await createChannel(store, key, input);
  if (!result.ok) {
    throw new Error(`create refused: ${result.reason}`);
  }
  return result.channel;
}

async function secretsOf(store: Storage, id: string) {
  return openSecrets(key, (await store.channels.credentialsOf(id)) ?? "");
}

describe("a channel's credentials at rest", () => {
  test("credentials are unreadable in the database file and readable through the repository", async () => {
    const store = await storage();
    const channel = await created(store);
    const [row] = await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "SELECT * FROM channels WHERE id = ?",
      [channel.id]
    );
    const text = JSON.stringify(row);
    expect(text).not.toContain(token);
    expect(text).not.toContain("whsec_");
    if (open?.location.backend === "sqlite") {
      const { file } = open.location;
      for (const path of [file, `${file}-wal`]) {
        // biome-ignore lint/performance/noAwaitInLoops: two files, read one after the other
        const bytes = (await Bun.file(path).exists())
          ? await Bun.file(path).text()
          : "";
        expect(bytes).not.toContain(token);
        expect(bytes).not.toContain("whsec_");
      }
    }
    const secrets = await secretsOf(store, channel.id);
    expect(secrets?.url).toBe(url);
    expect(secrets?.secret).toMatch(signingSecretShape);
  });
});

describe("the channels module", () => {
  test("a new channel gets its signing secret, and its page shows the secret and the URL's host, never the URL", async () => {
    const store = await storage();
    const channel = await created(store);
    expect(channel).toMatchObject({
      appliesToNew: true,
      config: {},
      locale: undefined,
      name: "فريق التشغيل",
      type: "webhook",
    });
    const read = await readChannelForm(store, key, channel.id, Date.now());
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.form.generated.secret).toMatch(signingSecretShape);
      expect(read.form.generated.secret).toBe(
        (await secretsOf(store, channel.id))?.secret ?? ""
      );
      expect(read.form.kept).toEqual(["url"]);
      expect(read.form.summary).toBe("hooks.example.test");
      expect(JSON.stringify(read.form)).not.toContain(token);
    }
    expect(await readChannelForm(store, key, "nope", Date.now())).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("a channel with a value missing or out of shape is refused and nothing is stored", async () => {
    const store = await storage();
    const refused: Record<string, string>[] = [
      {},
      { url: "ftp://example.test/" },
      { url: "" },
    ];
    for (const values of refused) {
      // biome-ignore lint/performance/noAwaitInLoops: each refusal is checked alone
      expect(await createChannel(store, key, { ...ops, values })).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    expect(await store.channels.list()).toEqual([]);
  });

  test("an edit that leaves the URL empty keeps it, a typed URL replaces it, and the signing secret stays", async () => {
    const store = await storage();
    const channel = await created(store);
    const before = await secretsOf(store, channel.id);
    const kept = await editChannel(store, key, channel.id, {
      ...ops,
      appliesToNew: false,
      locale: "en",
      name: "Ops",
      values: { url: "" },
    });
    expect(kept.ok && kept.channel).toMatchObject({
      appliesToNew: false,
      locale: "en",
      name: "Ops",
    });
    expect(await secretsOf(store, channel.id)).toEqual(before);
    const other = "https://other.example.test/hook";
    await editChannel(store, key, channel.id, {
      ...ops,
      values: { url: other },
    });
    expect(await secretsOf(store, channel.id)).toEqual({
      secret: before?.secret ?? "",
      url: other,
    });
  });

  test("asking for a new signing secret replaces it on save", async () => {
    const store = await storage();
    const channel = await created(store);
    const before = await secretsOf(store, channel.id);
    await editChannel(
      store,
      key,
      channel.id,
      { ...ops, values: {} },
      { renewGenerated: true }
    );
    const after = await secretsOf(store, channel.id);
    expect(after?.secret).toMatch(signingSecretShape);
    expect(after?.secret).not.toBe(before?.secret ?? "");
    expect(after?.url).toBe(url);
  });

  test("an edit cannot change the type, and an unknown channel is not found", async () => {
    const store = await storage();
    const channel = await created(store);
    const retyped: ChannelInput = { ...ops, type: "slack" };
    expect(await editChannel(store, key, channel.id, retyped)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await editChannel(store, key, "nope", ops)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("secrets the install key cannot open are replaced by typed ones, and an edit that keeps them is refused", async () => {
    const store = await storage();
    const channel = await store.channels.create(
      {
        appliesToNew: false,
        config: {},
        locale: undefined,
        name: "x",
        type: "webhook",
      },
      await encrypt(await scratchInstallKey(), JSON.stringify({ url }))
    );
    expect(
      await editChannel(store, key, channel.id, { ...ops, values: {} })
    ).toEqual({ ok: false, reason: "invalid" });
    const typed = await editChannel(store, key, channel.id, ops);
    expect(typed.ok).toBe(true);
    expect((await secretsOf(store, channel.id))?.url).toBe(url);
    expect((await secretsOf(store, channel.id))?.secret).toMatch(
      signingSecretShape
    );
  });

  test("the list names each channel with its URL's host and its newest notification", async () => {
    const store = await storage();
    const first = await created(store);
    const second = await created(store, {
      ...ops,
      name: "second",
      values: { url: `${origin}/ok` },
    });
    await sendTest(store, key, live, second.id);
    const listed = await listChannels(store, key);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.channels.map((item) => item.channel.id)).toEqual([
        first.id,
        second.id,
      ]);
      expect(listed.channels.map((item) => item.summary)).toEqual([
        "hooks.example.test",
        `127.0.0.1:${receiver.port}`,
      ]);
      expect(listed.channels[0]?.last).toBeUndefined();
      expect(listed.channels[1]?.last?.status).toBe("sent");
    }
  });

  test("a stored channel this version cannot read makes the list name it", async () => {
    const store = await storage();
    const channel = await created(store);
    await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "UPDATE channels SET type = ? WHERE id = ?",
      ["teams", channel.id]
    );
    expect(await listChannels(store, key)).toEqual({
      id: channel.id,
      ok: false,
      reason: "corrupt",
    });
  });

  test("deleting a channel answers whether it existed", async () => {
    const store = await storage();
    const channel = await created(store);
    expect(await deleteChannel(store, channel.id)).toEqual({ ok: true });
    expect(await deleteChannel(store, channel.id)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await store.channels.find(channel.id)).toBeUndefined();
  });

  test("no webhook channel write moves the change counter, since no status page shows one", async () => {
    const store = await storage();
    const before = await store.changeCounter();
    const channel = await created(store);
    await editChannel(store, key, channel.id, { ...ops, values: {} });
    await deleteChannel(store, channel.id);
    expect(await store.changeCounter()).toBe(before);
  });

  test("a database that does not answer is unavailable, never a throw", async () => {
    const store = await storage();
    const failing = () => Promise.reject(new Error("database gone"));
    const broken: Storage = {
      ...store,
      channels: {
        create: failing,
        credentialsOf: failing,
        find: failing,
        list: failing,
        remove: failing,
        update: failing,
      },
    };
    const unavailable = { ok: false, reason: "unavailable" } as const;
    expect(await listChannels(broken, key)).toEqual(unavailable);
    expect(await readChannelForm(broken, key, "x", Date.now())).toEqual(
      unavailable
    );
    expect(await createChannel(broken, key, ops)).toEqual(unavailable);
    expect(await editChannel(broken, key, "x", ops)).toEqual(unavailable);
    expect(await deleteChannel(broken, "x")).toEqual(unavailable);
    expect(await sendTest(broken, key, live, "x")).toEqual(unavailable);
  });
});

describe("send test", () => {
  test("sends one signed channel.test through the channel's delivery path and records it as a sent test", async () => {
    const store = await storage();
    const channel = await created(store, {
      ...ops,
      values: { url: `${origin}/ok` },
    });
    received.length = 0;
    const result = await sendTest(store, key, live, channel.id);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.send).toMatchObject({
      attempts: 1,
      channelId: channel.id,
      kind: "test",
      status: "sent",
    });
    expect(result.send.payload).toMatchObject({
      data: { channel: { id: channel.id, name: "فريق التشغيل" } },
      type: "channel.test",
    });
    expect(received).toHaveLength(1);
    const [got] = received;
    const secret = (await secretsOf(store, channel.id))?.secret ?? "";
    expect(got?.headers.get("webhook-signature")).toBe(
      await signWebhook(
        secret,
        got?.headers.get("webhook-id") ?? "",
        Number(got?.headers.get("webhook-timestamp")),
        got?.body ?? ""
      )
    );
    expect(got?.headers.get("webhook-id")).toBe(result.send.id);
    const read = await readChannelForm(store, key, channel.id, Date.now());
    expect(read.ok && read.form.recent.map((send) => send.id)).toEqual([
      result.send.id,
    ]);
  });

  test("a receiver that answers an error is a failed test with its reason, tried once and never queued", async () => {
    const store = await storage();
    const channel = await created(store, {
      ...ops,
      values: { url: `${origin}/broken` },
    });
    const result = await sendTest(store, key, live, channel.id);
    expect(result.ok && result.send).toMatchObject({
      attempts: 1,
      kind: "test",
      nextAttemptAt: undefined,
      status: "failed",
    });
    expect(result.ok && result.send.failure?.reason).toBe("unexpected_status");
    expect(await store.notifications.nextDueAt()).toBeUndefined();
  });

  test("an unknown channel is not found", async () => {
    const store = await storage();
    expect(await sendTest(store, key, live, "nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("the channel page lists its newest sends first, at most twenty", async () => {
    const store = await storage();
    const channel = await created(store, {
      ...ops,
      values: { url: `${origin}/ok` },
    });
    for (let n = 0; n < recentShown + 2; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each test send is recorded after the one before
      await sendTest(store, key, live, channel.id);
    }
    expect(recentShown).toBe(20);
    const read = await readChannelForm(store, key, channel.id, Date.now());
    expect(read.ok && read.form.recent).toHaveLength(20);
    if (read.ok) {
      const times = read.form.recent.map((send) => send.queuedAt);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    }
  });

  test("the channel page previews each notification in the channel language on the install's clock, and the read sends and records nothing", async () => {
    const store = await storage();
    await store.settings.set(timeZone, "Asia/Riyadh");
    await store.settings.set(publicAddress, "https://status.example.com");
    const channel = await created(store, {
      ...ops,
      locale: "en",
      type: "slack",
      values: { url: `${origin}/ok/${token}` },
    });
    const counter = await store.changeCounter();
    received.length = 0;
    const read = await readChannelForm(store, key, channel.id, Date.now());
    expect(read.ok && read.form.preview.map((each) => each.type)).toEqual([
      "monitor.down",
      "monitor.reminder",
      "monitor.recovered",
      "monitor.degraded_started",
      "monitor.degraded_ended",
      "monitor.certificate_expiring",
    ]);
    const down = read.ok ? (read.form.preview[0]?.body ?? "") : "";
    expect(down).toContain("The monitor is down.");
    expect(down).toContain("(GMT+3)");
    const links = read.ok ? (read.form.preview[0]?.links ?? []) : [];
    expect(links[0]?.url).toStartWith(
      "https://status.example.com/admin/monitors/"
    );
    expect(JSON.stringify(read)).not.toContain(token);
    expect(received).toEqual([]);
    expect(await store.notifications.recent(channel.id, 10)).toEqual([]);
    expect(await store.changeCounter()).toBe(counter);
  });

  test("the channel page previews each notification's time in the install's calendar", async () => {
    const store = await storage();
    await store.settings.set(calendar, "hijri");
    const channel = await created(store, {
      ...ops,
      locale: "en",
      type: "slack",
      values: { url: `${origin}/ok/${token}` },
    });
    const read = await readChannelForm(store, key, channel.id, Date.now());
    const down = read.ok ? (read.form.preview[0]?.body ?? "") : "";
    expect(down).toContain(" AH");
  });

  test("a channel with no language of its own previews in the install language", async () => {
    const store = await storage();
    const channel = await created(store, {
      ...ops,
      type: "slack",
      values: { url: `${origin}/ok` },
    });
    const read = await readChannelForm(store, key, channel.id, Date.now());
    expect(read.ok && read.form.preview[0]?.body).toContain("المراقبة متعطّلة.");
    await store.settings.set(installLanguage, "en");
    const english = await readChannelForm(store, key, channel.id, Date.now());
    expect(english.ok && english.form.preview[0]?.body).toContain(
      "The monitor is down."
    );
  });
});

describe("send test on a channel the install key cannot open", () => {
  test("fails without reaching the network and records why", async () => {
    const store = await storage();
    const channel = await store.channels.create(
      {
        appliesToNew: false,
        config: {},
        locale: undefined,
        name: "x",
        type: "webhook",
      },
      await encrypt(
        await scratchInstallKey(),
        JSON.stringify({ url: `${origin}/ok` })
      )
    );
    received.length = 0;
    const result = await sendTest(store, key, live, channel.id);
    expect(result.ok && result.send.status).toBe("failed");
    expect(result.ok && result.send.failure?.reason).toBe("unknown");
    expect(received).toEqual([]);
  });

  test("its page still previews every notification, which needs no secret", async () => {
    const store = await storage();
    const channel = await store.channels.create(
      {
        appliesToNew: false,
        config: {},
        locale: undefined,
        name: "x",
        type: "webhook",
      },
      await encrypt(
        await scratchInstallKey(),
        JSON.stringify({ url: `${origin}/ok` })
      )
    );
    const read = await readChannelForm(store, key, channel.id, Date.now());
    expect(read.ok && read.form.summary).toBe("");
    expect(read.ok && read.form.preview).toHaveLength(6);
  });
});

describe("send test keeps the recent sends bounded", () => {
  test("a channel keeps its newest fifty finished sends after many tests", async () => {
    const store = await storage();
    const channel = await created(store, {
      ...ops,
      values: { url: `${origin}/ok` },
    });
    for (let n = 0; n < 52; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each test send is recorded after the one before
      await sendTest(store, key, live, channel.id);
    }
    expect(await store.notifications.recent(channel.id, 100)).toHaveLength(50);
  });
});

const mail = (values: Readonly<Record<string, string>>): ChannelInput => ({
  appliesToNew: true,
  name: "بريد الفريق",
  type: "email",
  values: {
    from: "Raaqeb <alerts@example.test>",
    host: "127.0.0.1",
    port: "25",
    security: "none",
    to: "ops@example.test",
    ...values,
  },
});

describe("an email channel", () => {
  test("its password is unreadable in the database and readable through the repository; its server stays in clear", async () => {
    const store = await storage();
    const channel = await created(
      store,
      mail({
        password: "Sm7pPassw0rd",
        security: "starttls",
        username: "alerts",
      })
    );
    const [row] = await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "SELECT * FROM channels WHERE id = ?",
      [channel.id]
    );
    expect(JSON.stringify(row)).not.toContain("Sm7pPassw0rd");
    expect(channel.config).toEqual({
      from: "Raaqeb <alerts@example.test>",
      host: "127.0.0.1",
      port: "25",
      security: "starttls",
      to: "ops@example.test",
      username: "alerts",
    });
    expect(await secretsOf(store, channel.id)).toEqual({
      password: "Sm7pPassw0rd",
    });
    const read = await readChannelForm(store, key, channel.id, Date.now());
    expect(read.ok && read.form.kept).toEqual(["password"]);
    expect(read.ok && read.form.summary).toBe("ops@example.test");
  });

  test("send test reaches the SMTP server through the channel's own path, with times in the install zone", async () => {
    const store = await storage();
    await store.settings.set(timeZone, "Asia/Riyadh");
    const server = fakeSmtp();
    try {
      const channel = await created(store, mail({ port: String(server.port) }));
      const result = await sendTest(store, key, live, channel.id);
      expect(result.ok && result.send.status).toBe("sent");
      expect(server.messages.length).toBe(1);
      const text = bodyText(parse(server.messages[0] ?? ""));
      expect(text).toContain("القناة: بريد الفريق");
      expect(text).toContain("(غرينتش+3)");
    } finally {
      server.stop();
    }
  });

  test("a refused recipient is a failed send test with the server's code, never a silent success", async () => {
    const store = await storage();
    const server = fakeSmtp({ replies: { RCPT: "550 5.1.1 no such user" } });
    try {
      const channel = await created(store, mail({ port: String(server.port) }));
      const result = await sendTest(store, key, live, channel.id);
      expect(result.ok && result.send).toMatchObject({
        failure: {
          params: { observed: 550, reason: "unexpected_status" },
          reason: "unexpected_status",
        },
        status: "failed",
      });
    } finally {
      server.stop();
    }
  });
});
