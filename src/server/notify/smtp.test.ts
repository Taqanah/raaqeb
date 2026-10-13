import { afterEach, describe, expect, test } from "bun:test";
import type { MailMessage, SmtpServer } from "./channel.ts";
import {
  bodyText,
  decodeWords,
  type FakeSmtp,
  fakeSmtp,
  parse,
  partsOf,
} from "./fixture.ts";
import { SmtpReplyError, SmtpTimeoutError, sendSmtp } from "./smtp.ts";

const message: MailMessage = {
  from: { address: "alerts@example.test", name: "راقب" },
  html: '<!doctype html><html lang="ar" dir="rtl"><body dir="rtl">المراقبة متعطّلة.</body></html>\n',
  id: "01999a3c-0000-7000-8000-000000000001",
  subject: "API: متعطّل",
  text: "المراقبة متعطّلة.\n\nالمراقبة: API\nالرابط: https://status.example.test/admin/monitors/0199\n",
  to: ["ops@example.test", "oncall@example.test"],
};

const plain = (port: number): SmtpServer => ({
  host: "127.0.0.1",
  password: undefined,
  port,
  security: "none",
  username: undefined,
});

let servers: FakeSmtp[] = [];
const serve = (options?: Parameters<typeof fakeSmtp>[0]): FakeSmtp => {
  const server = fakeSmtp(options);
  servers.push(server);
  return server;
};

afterEach(() => {
  for (const server of servers) {
    server.stop();
  }
  servers = [];
});

/** One send; the wait for setup and a quiet socket is the limit unless the test sets a shorter one, as the channel does. */
const send = (
  server: SmtpServer,
  mail: MailMessage,
  limitMs: number,
  waitMs = limitMs
): Promise<void> => sendSmtp(server, mail, limitMs, waitMs);

/** How a promise ended: its rejection, or nothing when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
}

describe("an email over SMTP", () => {
  test("reaches the server from the sender to every recipient, as one message in UTF-8", async () => {
    const server = serve();
    await send(plain(server.port), message, 5000);
    expect(server.commands).toContain("MAIL FROM:<alerts@example.test>");
    expect(server.commands).toContain("RCPT TO:<ops@example.test>");
    expect(server.commands).toContain("RCPT TO:<oncall@example.test>");
    expect(server.messages.length).toBe(1);
    const { headers } = parse(server.messages[0] ?? "");
    expect(decodeWords(headers.subject ?? "")).toBe("API: متعطّل");
    expect(decodeWords(headers.from ?? "")).toBe("راقب <alerts@example.test>");
    expect(headers.to).toBe("ops@example.test, oncall@example.test");
  });

  test("is the plain-text part then the HTML part as alternatives, each UTF-8 in base64, so a client that cannot show HTML reads the text", async () => {
    const server = serve();
    await send(plain(server.port), message, 5000);
    const sent = parse(server.messages[0] ?? "");
    expect(sent.headers["content-type"]).toStartWith("multipart/alternative;");
    const parts = partsOf(sent);
    expect(parts.map((each) => each.headers["content-type"])).toEqual([
      "text/plain; charset=utf-8",
      "text/html; charset=utf-8",
    ]);
    for (const part of parts) {
      expect(part.headers["content-transfer-encoding"]).toBe("base64");
    }
    expect(bodyText(sent)).toBe(message.text);
    expect(bodyText(sent, "text/html")).toBe(message.html);
  });

  test("carries a Message-ID made from the notification's id, so a retry is the same message", async () => {
    const server = serve();
    await send(plain(server.port), message, 5000);
    await send(plain(server.port), message, 5000);
    const ids = server.messages.map((raw) => parse(raw).headers["message-id"]);
    expect(ids).toEqual([
      `<${message.id}@example.test>`,
      `<${message.id}@example.test>`,
    ]);
  });

  test("greets with the sender's domain, never the host's own name", async () => {
    const server = serve();
    await send(plain(server.port), message, 5000);
    expect(server.commands[0]).toBe("EHLO example.test");
  });

  test("closes its connection after the one message", async () => {
    const server = serve();
    await send(plain(server.port), message, 5000);
    await server.closed();
    expect(
      server.commands.filter((line) => line.startsWith("MAIL")).length
    ).toBe(1);
  });

  test("a plain connection never asks for STARTTLS and never sends AUTH, even when the server offers them", async () => {
    const server = serve({ offerAuth: true, offerStartTls: true });
    await send(
      { ...plain(server.port), password: "s3cret", username: "alerts" },
      message,
      5000
    );
    expect(server.commands.some((line) => line.startsWith("STARTTLS"))).toBe(
      false
    );
    expect(server.commands.some((line) => line.startsWith("AUTH"))).toBe(false);
  });

  test("STARTTLS is required: a server that does not offer it gets no message", async () => {
    const server = serve();
    const error = await rejection(
      send({ ...plain(server.port), security: "starttls" }, message, 5000)
    );
    expect(error).toBeInstanceOf(Error);
    expect(server.commands.some((line) => line.startsWith("MAIL"))).toBe(false);
  });

  test("STARTTLS is required: a server that cannot upgrade gets no message", async () => {
    const server = serve({ offerStartTls: true });
    const error = await rejection(
      send({ ...plain(server.port), security: "starttls" }, message, 5000)
    );
    expect(error).toBeInstanceOf(Error);
    expect(server.commands.some((line) => line.startsWith("MAIL"))).toBe(false);
  });

  test("a refused recipient rejects with the server's reply code and text", async () => {
    const server = serve({ replies: { RCPT: "550 5.1.1 no such user" } });
    const error = await rejection(send(plain(server.port), message, 5000));
    expect(error).toBeInstanceOf(SmtpReplyError);
    expect(error instanceof SmtpReplyError && error.code).toBe(550);
    expect(error instanceof Error && error.message).toContain("no such user");
    expect(server.messages).toEqual([]);
  });

  test("a message refused at its end rejects with the server's reply code", async () => {
    const server = serve({ replies: { ".": "554 5.7.1 rejected as spam" } });
    const error = await rejection(send(plain(server.port), message, 5000));
    expect(error instanceof SmtpReplyError && error.code).toBe(554);
  });

  test("a refused connection rejects with ECONNREFUSED", async () => {
    const server = serve();
    const { port } = server;
    server.stop();
    const error = await rejection(send(plain(port), message, 5000));
    expect((error as { code?: unknown } | undefined)?.code).toBe(
      "ECONNREFUSED"
    );
  });

  test("a server that never greets fails at the wait, as one that sent no greeting, before the limit", async () => {
    const server = serve({ silent: true });
    const started = performance.now();
    const error = await rejection(send(plain(server.port), message, 1500, 100));
    expect(error instanceof SmtpTimeoutError && error.kind).toBe("greeting");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a server that greets and then stays quiet for the wait fails as one that stalled, before the limit", async () => {
    const server = serve({ mute: "MAIL" });
    const started = performance.now();
    const error = await rejection(send(plain(server.port), message, 1500, 100));
    expect(error instanceof SmtpTimeoutError && error.kind).toBe("stalled");
    expect(server.commands.some((line) => line.startsWith("MAIL"))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a server that keeps answering a line at a time past the limit fails at the limit, as a plain timeout", async () => {
    const server = serve({ trickle: true });
    const started = performance.now();
    const error = await rejection(send(plain(server.port), message, 400, 200));
    expect(error instanceof DOMException && error.name).toBe("TimeoutError");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a server that agrees to STARTTLS and never answers the handshake fails as a plain timeout", async () => {
    const server = serve({
      offerStartTls: true,
      replies: { STARTTLS: "220 2.0.0 ready" },
    });
    const error = await rejection(
      send({ ...plain(server.port), security: "starttls" }, message, 1500, 100)
    );
    expect(error instanceof DOMException && error.name).toBe("TimeoutError");
  });

  test("one refused recipient among several fails the attempt with its reply code, so the operator sees it", async () => {
    const server = serve({ refuseRecipient: "oncall@example.test" });
    const error = await rejection(send(plain(server.port), message, 5000));
    expect(error instanceof SmtpReplyError && error.code).toBe(550);
  });

  test("a server name that does not resolve rejects with ENOTFOUND", async () => {
    const error = await rejection(
      send({ ...plain(25), host: "nope.invalid" }, message, 5000)
    );
    expect((error as { code?: unknown } | undefined)?.code).toBe("ENOTFOUND");
  });

  test("a server name that holds a certificate word is still a DNS failure", async () => {
    const error = await rejection(
      send({ ...plain(25), host: "mail.expired.invalid" }, message, 5000)
    );
    expect((error as { code?: unknown } | undefined)?.code).toBe("ENOTFOUND");
  });

  test("a server whose certificate no authority signed rejects with the platform's certificate code", async () => {
    const fixtures = `${import.meta.dir}/../checks/fixtures`;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
      tls: {
        cert: Bun.file(`${fixtures}/tls-cert.pem`),
        key: Bun.file(`${fixtures}/tls-key.pem`),
      },
    });
    try {
      const error = await rejection(
        send({ ...plain(server.port), security: "tls" }, message, 5000)
      );
      expect((error as { code?: unknown } | undefined)?.code).toBe(
        "DEPTH_ZERO_SELF_SIGNED_CERT"
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("a subscriber's email over SMTP", () => {
  test("carries the List-Unsubscribe pair as written", async () => {
    const server = serve();
    await send(
      plain(server.port),
      {
        ...message,
        headers: {
          "List-Unsubscribe":
            "<https://status.example.test/subscriptions/abc/unsubscribe>",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      },
      5000
    );
    const { headers } = parse(server.messages[0] ?? "");
    expect(headers["list-unsubscribe"]).toBe(
      "<https://status.example.test/subscriptions/abc/unsubscribe>"
    );
    expect(headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
  });
});
