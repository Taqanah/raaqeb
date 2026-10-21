import { afterEach, describe, expect, test } from "bun:test";
import { createChannel } from "@/server/notify/channels.ts";
import {
  bodyText,
  decodeWords,
  fakeSmtp,
  htmlLinks,
  htmlText,
  parse,
} from "@/server/notify/fixture.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  accountIdOf,
  authWithOperator,
  type Scratch,
  scratchStorage,
  testEmail,
} from "./fixture.ts";
import {
  authEmailChannel,
  authEmailChannelOf,
  authMailOver,
  emailChangeNoticeOver,
  mayChangeChannel,
  sendAuthMail,
} from "./mail.ts";

// Auth mail: the reset link, the code
// and the test message go at once to the operator's address through one
// email channel, the chosen one or else the oldest, in the operator language.

let open: Scratch | undefined;
async function scratch(): Promise<Scratch> {
  open = await scratchStorage();
  return open;
}
afterEach(async () => {
  await open?.cleanup();
  open = undefined;
});

/** The operator's account, reading English. */
async function englishOperator(storage: Storage): Promise<void> {
  await authWithOperator(storage);
  await storage.operatorAccounts.setPreferences(await accountIdOf(storage), {
    operatorLanguage: "en",
  });
}

const io = { fetch, now: Date.now };
const lineBreak = /\r?\n/;
const refusedOrUnverified = /unexpected_status|certificate_invalid/;

async function emailChannel(
  s: Scratch,
  name: string,
  port: number,
  password?: string
): Promise<string> {
  const created = await createChannel(s.storage, s.boot.installKey, {
    appliesToNew: false,
    name,
    type: "email",
    values: {
      from: "راقب <raaqeb@example.com>",
      host: "127.0.0.1",
      port: String(port),
      security: password ? "starttls" : "none",
      to: "team@example.com",
      ...(password ? { password, username: "mailer" } : {}),
    },
  });
  if (!created.ok) {
    throw new Error("the email channel was not created");
  }
  return created.channel.id;
}

/** The message's subject, its encoded words read back. */
function subjectOf(message: string): string {
  return decodeWords(parse(message).headers.subject ?? "");
}

/** The message's body as text. */
function bodyOf(message: string): string {
  return bodyText(parse(message));
}

/** The message's HTML part. */
function htmlOf(message: string): string {
  return bodyText(parse(message), "text/html");
}

describe("who changes the channel auth mail goes through", () => {
  test("is an owner alone: the channel in force, and a first email channel made while none is", async () => {
    const s = await scratch();
    expect(
      await mayChangeChannel(s.storage, { role: "admin" }, { type: "email" })
    ).toBe(false);
    expect(
      await mayChangeChannel(s.storage, { role: "owner" }, { type: "email" })
    ).toBe(true);
    expect(
      await mayChangeChannel(s.storage, { role: "admin" }, { type: "webhook" })
    ).toBe(true);
    const first = await emailChannel(s, "First", 2525);
    expect(
      await mayChangeChannel(s.storage, { role: "admin" }, { id: first })
    ).toBe(false);
    expect(
      await mayChangeChannel(s.storage, { role: "owner" }, { id: first })
    ).toBe(true);
    // Another email channel made now is not the one in force.
    expect(
      await mayChangeChannel(s.storage, { role: "admin" }, { type: "email" })
    ).toBe(true);
    const second = await emailChannel(s, "Second", 2526);
    expect(
      await mayChangeChannel(s.storage, { role: "admin" }, { id: second })
    ).toBe(true);
    await s.storage.settings.set(authEmailChannel, second);
    expect(
      await mayChangeChannel(s.storage, { role: "admin" }, { id: second })
    ).toBe(false);
    expect(
      await mayChangeChannel(s.storage, { role: "admin" }, { id: first })
    ).toBe(true);
  });

  test("is never an owner's API key: the channel in force, nor a first email channel", async () => {
    const s = await scratch();
    const ownerKey = {
      apiKey: { id: "k", name: "ci" },
      role: "owner",
    } as const;
    expect(await mayChangeChannel(s.storage, ownerKey, { type: "email" })).toBe(
      false
    );
    const first = await emailChannel(s, "First", 2525);
    expect(await mayChangeChannel(s.storage, ownerKey, { id: first })).toBe(
      false
    );
    expect(
      await mayChangeChannel(s.storage, ownerKey, { type: "webhook" })
    ).toBe(true);
  });

  test("allows nothing when the database cannot answer, never a thrown error", async () => {
    const s = await scratch();
    await s.storage.close();
    expect(
      await mayChangeChannel(s.storage, { role: "admin" }, { type: "webhook" })
    ).toBe(false);
  });
});

describe("the channel auth mail goes through", () => {
  test("is the chosen email channel, else the oldest email channel, and nothing without one", async () => {
    const s = await scratch();
    expect(await authEmailChannelOf(s.storage)).toBeUndefined();
    await createChannel(s.storage, s.boot.installKey, {
      appliesToNew: false,
      name: "Ops webhook",
      type: "webhook",
      values: { url: "https://example.com/hook" },
    });
    expect(await authEmailChannelOf(s.storage)).toBeUndefined();
    const first = await emailChannel(s, "First", 2525);
    const second = await emailChannel(s, "Second", 2526);
    expect((await authEmailChannelOf(s.storage))?.id).toBe(first);
    await s.storage.settings.set(authEmailChannel, second);
    expect((await authEmailChannelOf(s.storage))?.id).toBe(second);
  });

  test("a chosen channel that was deleted, or is not email, gives way to the oldest email channel", async () => {
    const s = await scratch();
    const first = await emailChannel(s, "First", 2525);
    await s.storage.settings.set(authEmailChannel, "gone");
    expect((await authEmailChannelOf(s.storage))?.id).toBe(first);
    const hook = await createChannel(s.storage, s.boot.installKey, {
      appliesToNew: false,
      name: "Ops webhook",
      type: "webhook",
      values: { url: "https://example.com/hook" },
    });
    await s.storage.settings.set(
      authEmailChannel,
      hook.ok ? hook.channel.id : ""
    );
    expect((await authEmailChannelOf(s.storage))?.id).toBe(first);
  });
});

describe("sending auth mail", () => {
  test("goes to the operator's address only, with the subject and sentence in the operator language and the link on its own line", async () => {
    const s = await scratch();
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      const link = "http://raaqeb.test/reset-password?token=abc";
      expect(
        await sendAuthMail(s.storage, s.boot.installKey, io, {
          kind: "reset_link",
          to: testEmail,
          value: link,
        })
      ).toEqual({ ok: true });
      expect(smtp.messages).toHaveLength(1);
      const commands = smtp.commands.join("\n");
      expect(commands).toContain(`RCPT TO:<${testEmail}>`);
      expect(commands).not.toContain("team@example.com");
      const message = smtp.messages[0] ?? "";
      expect(subjectOf(message)).toBe("راقب: رابط إعادة تعيين كلمة المرور");
      const body = bodyOf(message);
      expect(body).toContain("افتح هذا الرابط لتعيين كلمة مرور جديدة.");
      expect(body.split(lineBreak)).toContain(link);
    } finally {
      smtp.stop();
    }
  });

  test("follows the recipient's operator language, so an English operator reads English", async () => {
    const s = await scratch();
    await englishOperator(s.storage);
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      await sendAuthMail(s.storage, s.boot.installKey, io, {
        kind: "code",
        to: testEmail,
        value: "123456",
      });
      const message = smtp.messages[0] ?? "";
      expect(subjectOf(message)).toBe("Raaqeb: your one-time code");
      expect(bodyOf(message).split(lineBreak)).toContain("123456");
    } finally {
      smtp.stop();
    }
  });

  test("goes to an address with no account in the install language, as an invitation does, its link a button", async () => {
    const s = await scratch();
    await englishOperator(s.storage);
    const smtp = fakeSmtp();
    const link = "http://raaqeb.test/invitation?token=rqi_abc";
    try {
      await emailChannel(s, "Mail", smtp.port);
      expect(
        await sendAuthMail(s.storage, s.boot.installKey, io, {
          kind: "invitation",
          to: "new@example.com",
          value: link,
        })
      ).toEqual({ ok: true });
      const message = smtp.messages[0] ?? "";
      expect(subjectOf(message)).toBe("راقب: دعوة إلى الفريق");
      expect(bodyOf(message).split(lineBreak)).toContain(link);
      expect(htmlLinks(htmlOf(message))).toEqual([
        { url: link, words: "قبول الدعوة" },
      ]);
    } finally {
      smtp.stop();
    }
  });

  test("a test message names no link and no code", async () => {
    const s = await scratch();
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      expect(
        await sendAuthMail(s.storage, s.boot.installKey, io, {
          kind: "test",
          to: testEmail,
        })
      ).toEqual({ ok: true });
      expect(subjectOf(smtp.messages[0] ?? "")).toBe("راقب: رسالة تجريبية");
      const html = htmlOf(smtp.messages[0] ?? "");
      expect(htmlLinks(html)).toEqual([]);
      expect(htmlText(html).split("\n")).toContain(
        "هذه رسالة تجريبية من راقب. وصولها يعني أن بريد تسجيل الدخول يعمل."
      );
    } finally {
      smtp.stop();
    }
  });

  test("the HTML part opens the reset link from a button with the reset page's title, and shows no address", async () => {
    const s = await scratch();
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      const link = "http://raaqeb.test/reset-password?token=abc";
      await sendAuthMail(s.storage, s.boot.installKey, io, {
        kind: "reset_link",
        to: testEmail,
        value: link,
      });
      const html = htmlOf(smtp.messages[0] ?? "");
      expect(html).toContain('<html lang="ar" dir="rtl">');
      expect(htmlLinks(html)).toEqual([
        { url: link, words: "تعيين كلمة مرور جديدة" },
      ]);
      const shown = htmlText(html);
      expect(shown.split("\n")).not.toContain("راقب");
      expect(shown).toContain("افتح هذا الرابط لتعيين كلمة مرور جديدة.");
      expect(shown).not.toContain(link);
    } finally {
      smtp.stop();
    }
  });

  test("the HTML part shows a one-time code on a line of its own, left to right, in the operator language", async () => {
    const s = await scratch();
    await englishOperator(s.storage);
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      await sendAuthMail(s.storage, s.boot.installKey, io, {
        kind: "code",
        to: testEmail,
        value: "123456",
      });
      const html = htmlOf(smtp.messages[0] ?? "");
      expect(html).toContain('<html lang="en" dir="ltr">');
      expect(html).toContain(">123456</span>");
      expect(htmlText(html).split("\n")).toContain("123456");
      expect(htmlLinks(html)).toEqual([]);
    } finally {
      smtp.stop();
    }
  });

  test("answers no channel without an email channel, and sends nothing", async () => {
    const s = await scratch();
    expect(
      await sendAuthMail(s.storage, s.boot.installKey, io, {
        kind: "test",
        to: testEmail,
      })
    ).toEqual({ ok: false, reason: "no_channel" });
  });

  test("reports the channel's failure with its reason and every secret taken out", async () => {
    const s = await scratch();
    const smtp = fakeSmtp({
      offerAuth: true,
      offerStartTls: true,
      refuseRecipient: testEmail,
      replies: { RCPT: "550 5.1.1 no such user hunter2 here" },
    });
    try {
      await emailChannel(s, "Mail", smtp.port, "hunter2");
      const result = await sendAuthMail(s.storage, s.boot.installKey, io, {
        kind: "test",
        to: testEmail,
      });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === "failed") {
        expect(result.failure.reason).toMatch(refusedOrUnverified);
        expect(result.failure.error ?? "").not.toContain("hunter2");
      } else {
        throw new Error("expected a failed send");
      }
    } finally {
      smtp.stop();
    }
  });
});

describe("the mail an instance sends", () => {
  test("a reset link or a code that did not go is logged, never thrown, so the request answers as for any address", async () => {
    const s = await scratch();
    const lines: string[] = [];
    const mail = authMailOver(s.storage, s.boot.installKey, io, (line) =>
      lines.push(line)
    );
    await expect(
      mail.resetLink(testEmail, "http://x/y")
    ).resolves.toBeUndefined();
    await expect(mail.code(testEmail, "123456")).resolves.toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).toContain("no email channel");
  });
});

describe("the notice of an email change", () => {
  test("goes to the address the account had, naming the new address on a line of its own", async () => {
    const s = await scratch();
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      const notice = emailChangeNoticeOver(
        s.storage,
        s.boot.installKey,
        io,
        () => undefined
      );
      await notice("old@example.com", "new@example.com");
      expect(smtp.messages).toHaveLength(1);
      const commands = smtp.commands.join("\n");
      expect(commands).toContain("RCPT TO:<old@example.com>");
      expect(commands).not.toContain("RCPT TO:<new@example.com>");
      const message = smtp.messages[0] ?? "";
      expect(subjectOf(message)).toBe("راقب: تغيّر بريد حسابك");
      expect(bodyOf(message).split(lineBreak)).toContain("new@example.com");
      // The HTML part names it too, as a line of its own with no button.
      const html = htmlOf(message);
      expect(htmlText(html).split("\n")).toContain("new@example.com");
      expect(htmlLinks(html)).toEqual([]);
    } finally {
      smtp.stop();
    }
  });

  test("one that did not go is logged, never thrown", async () => {
    const s = await scratch();
    const lines: string[] = [];
    const notice = emailChangeNoticeOver(
      s.storage,
      s.boot.installKey,
      io,
      (line) => lines.push(line)
    );
    await expect(
      notice("old@example.com", "new@example.com")
    ).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).toContain("no email channel");
  });
});
