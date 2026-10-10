/**
 * The generic webhook: the notification's payload as the
 * JSON body of a POST, signed by the Standard Webhooks scheme. The headers are `webhook-id` (the notification's id, the same on
 * every retry, so a receiver can drop a duplicate), `webhook-timestamp`
 * (Unix seconds of the attempt) and `webhook-signature`, `v1,` and the
 * base64 HMAC-SHA256 of `id.timestamp.body` under the secret's bytes. The
 * signing secret is `whsec_` and the base64 of 32 random bytes, generated
 * by Raaqeb. WebCrypto does the HMAC; no dependency.
 */
import { webhookDeclaration } from "@/shared/schemas/channel.ts";
import type { NotificationChannel } from "./channel.ts";

const secretPrefix = "whsec_";
const secretBytes = 32;

/** The signature header's value for one attempt: `v1,<base64>`. */
export async function signWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.fromBase64(secret.slice(secretPrefix.length)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`)
  );
  return `v1,${new Uint8Array(signature).toBase64()}`;
}

/** A new signing secret. */
export function newSigningSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(secretBytes));
  return `${secretPrefix}${bytes.toBase64()}`;
}

export const webhookChannel: NotificationChannel = {
  declaration: webhookDeclaration,
  generate: { secret: newSigningSecret },
  send: async (config, payload, transport) => {
    const body = JSON.stringify(payload.notification);
    const timestamp = Math.floor(transport.now() / 1000);
    await transport.post(config.url ?? "", {
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "Raaqeb",
        "webhook-id": payload.id,
        "webhook-signature": await signWebhook(
          config.secret ?? "",
          payload.id,
          timestamp,
          body
        ),
        "webhook-timestamp": String(timestamp),
      },
    });
  },
};
