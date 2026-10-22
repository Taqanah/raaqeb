// The management API on an install of its own: every operation of the
// table called by a key of every role, and with no key, an expired key and
// a revoked one; then a key's calls doing what the admin does, reading back
// no secret.

import { hashApiKey } from "@/server/api/keys.ts";
import {
  type ManagementOperation,
  managementOperations,
} from "@/shared/api/management.ts";
import { keyCan, type Role, roles } from "@/shared/domain/roles.ts";
import { expect, test } from "./support/fixtures.ts";
import { type Install, seedAccount, spawnInstall } from "./support/spawn.ts";

let install: Install;

const secretOf = (name: string) => `rqk_e2e-${name}-key-for-the-table`;

test.beforeAll(async () => {
  install = await spawnInstall({
    account: true,
    language: "en",
    records: async (storage) => {
      const accountOf = async (role: Role) => {
        const email = `${role}@example.com`;
        await seedAccount(storage, {
          email,
          name: role,
          password: "correct horse battery",
          role,
        });
        return (await storage.operatorAccounts.findByEmail(email))?.id ?? "";
      };
      for (const role of roles) {
        // biome-ignore lint/performance/noAwaitInLoops: five accounts, made in turn
        const accountId = await accountOf(role);
        await storage.apiKeys.create({
          accountId,
          createdAt: Date.now(),
          expiresAt: null,
          id: `key-${role}`,
          name: role,
          role,
          tokenHash: hashApiKey(secretOf(role)),
        });
      }
      const owner =
        await storage.operatorAccounts.findByEmail("owner@example.com");
      for (const [id, expiresAt] of [
        ["expired", Date.now() - 1000],
        ["revoked", null],
      ] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: two keys, made in turn
        await storage.apiKeys.create({
          accountId: owner?.id ?? "",
          createdAt: Date.now() - 2000,
          expiresAt,
          id,
          name: id,
          role: "owner",
          tokenHash: hashApiKey(secretOf(id)),
        });
      }
      await storage.apiKeys.revoke("revoked");
    },
  });
});

test.afterAll(async () => {
  await install.stop();
});

/** A request of the operation with made-up ids and an empty body, which the server refuses before it changes anything. */
function made(operation: ManagementOperation, secret?: string) {
  const path = operation.path.replaceAll(/\{\w+\}/g, "made-up");
  return fetch(`${install.origin}${path}`, {
    body: operation.body === undefined ? undefined : "{}",
    headers: {
      ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }),
      ...(operation.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    method: operation.method.toUpperCase(),
  });
}

const operations: [string, ManagementOperation][] =
  Object.entries(managementOperations);

test("every operation lets exactly the roles its permission names call it, and refuses the rest with forbidden", async () => {
  for (const [name, operation] of operations) {
    for (const role of roles) {
      // biome-ignore lint/performance/noAwaitInLoops: one call at a time, so no key's limit is spent
      const response = await made(operation, secretOf(role));
      const where = `${name} as ${role}: ${response.status}`;
      if (keyCan(role, operation.permission)) {
        expect([401, 403, 429], where).not.toContain(response.status);
      } else {
        expect(response.status, where).toBe(403);
        expect(await response.json(), where).toEqual({ reason: "forbidden" });
      }
    }
  }
});

test("every operation refuses a call with no key, an expired key or a revoked one, naming the Bearer scheme", async () => {
  for (const [name, operation] of operations) {
    for (const secret of [
      undefined,
      secretOf("expired"),
      secretOf("revoked"),
      "rqk_nobody-holds-this",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one call at a time
      const response = await made(operation, secret);
      const where = `${name} with ${secret ?? "no key"}`;
      expect(response.status, where).toBe(401);
      expect(response.headers.get("www-authenticate"), where).toBe("Bearer");
      expect(await response.json(), where).toEqual({
        reason: "unauthenticated",
      });
    }
  }
});

const call = (
  method: string,
  path: string,
  body?: unknown,
  role: Role = "owner"
) =>
  fetch(`${install.origin}/api/v1${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${secretOf(role)}`,
      "content-type": "application/json",
    },
    method,
  });

test("a key creates, reads, lists, pauses, groups and deletes a monitor as the admin form does", async () => {
  const input = {
    config: { type: "http", url: "http://127.0.0.1:1/" },
    intervalMs: 3_600_000,
    name: "API site",
    retries: 0,
    timeoutMs: 1000,
  };
  const created = await call("POST", "/monitors", input, "editor");
  expect(created.status).toBe(201);
  const monitor = await created.json();
  expect(monitor).toMatchObject({ name: "API site", paused: false });

  const listed = await (await call("GET", "/monitors?limit=1")).json();
  expect(listed).toMatchObject({ limit: 1, offset: 0, total: 1 });
  expect(listed.items[0].id).toBe(monitor.id);

  expect((await call("POST", `/monitors/${monitor.id}/pause`)).status).toBe(
    204
  );
  // Pausing again changes nothing and answers the same.
  expect((await call("POST", `/monitors/${monitor.id}/pause`)).status).toBe(
    204
  );
  expect(
    await (
      await call("GET", `/monitors/${monitor.id}`, undefined, "viewer")
    ).json()
  ).toMatchObject({ id: monitor.id, paused: true });

  expect(
    (await call("POST", "/groups/Core/monitors", { monitorIds: [monitor.id] }))
      .status
  ).toBe(204);
  expect(await (await call("GET", "/groups")).json()).toMatchObject({
    items: [{ monitorIds: [monitor.id], name: "Core" }],
  });

  const refused = await call("PUT", `/monitors/${monitor.id}`, {
    ...input,
    intervalMs: 1,
  });
  expect(refused.status).toBe(422);
  const { issues } = await refused.json();
  expect(issues).toContainEqual(
    expect.objectContaining({ path: ["intervalMs"] })
  );

  expect((await call("DELETE", `/monitors/${monitor.id}`)).status).toBe(204);
  // Deleting again is the same answer: the monitor is gone either way.
  expect((await call("DELETE", `/monitors/${monitor.id}`)).status).toBe(204);
  expect((await call("GET", `/monitors/${monitor.id}`)).status).toBe(404);
});

test("a refusal as invalid names the parts of the input a rule refused, as the docs promise", async () => {
  const issuesOf = async (response: Response) => {
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.reason).toBe("invalid");
    return body.issues;
  };
  expect(
    await issuesOf(
      await call("POST", "/channels", {
        appliesToNew: false,
        name: "Alerts",
        type: "ntfy",
        values: { server: "https://ntfy.example.test/path", topic: "alerts" },
      })
    )
  ).toEqual([expect.objectContaining({ path: ["values", "server"] })]);
  expect(
    await issuesOf(
      await call("POST", "/channels", {
        appliesToNew: false,
        name: "Pager",
        type: "pagerduty",
        values: { routingKey: "0123456789abcdef0123456789abcdef0" },
      })
    )
  ).toEqual([expect.objectContaining({ path: ["values", "routingKey"] })]);

  const component = async (name: string) =>
    (
      await (
        await call("POST", "/components", {
          monitorIds: [],
          name: { en: name },
          status: "operational",
        })
      ).json()
    ).id;
  const web = await component("Web");
  const api = await component("API");
  const incident = await (
    await call("POST", "/incidents", {
      impact: "major",
      message: { en: "We are looking." },
      stage: "investigating",
      statuses: [
        { componentId: web, status: "major_outage" },
        { componentId: api, status: "major_outage" },
      ],
      title: { en: "Slow checkout" },
    })
  ).json();
  expect(
    await issuesOf(
      await call("POST", `/incidents/${incident.id}/updates`, {
        message: { en: "Found it." },
        stage: "identified",
        statuses: [{ componentId: web, status: "operational" }],
      })
    )
  ).toEqual([expect.objectContaining({ path: ["statuses"] })]);
});

test("a channel's secret is written through the API and never read back", async () => {
  const hook = "https://hooks.slack.com/services/T000/B000/secret-part";
  const created = await call(
    "POST",
    "/channels",
    {
      appliesToNew: false,
      name: "Ops",
      type: "slack",
      values: { url: hook },
    },
    "admin"
  );
  expect(created.status).toBe(201);
  const channel = await created.json();
  const read = await call("GET", `/channels/${channel.id}`);
  const text = await read.text();
  expect(read.status).toBe(200);
  expect(text).not.toContain("secret-part");
  expect(JSON.parse(text)).toMatchObject({ kept: ["url"], name: "Ops" });
  expect(await (await call("GET", "/channels")).text()).not.toContain(
    "secret-part"
  );
  expect((await call("DELETE", `/channels/${channel.id}`)).status).toBe(204);
});

test("a body that is not JSON is malformed, a path no operation has is not found, and a method the path does not take names the ones it does", async () => {
  const malformed = await fetch(`${install.origin}/api/v1/monitors`, {
    body: "{",
    headers: {
      authorization: `Bearer ${secretOf("owner")}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ reason: "malformed" });
  const missing = await call("GET", "/nothing-here");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ reason: "not_found" });
  const method = await call("PATCH", "/monitors");
  expect(method.status).toBe(405);
  expect(method.headers.get("allow")).toBe("GET, POST");
});
