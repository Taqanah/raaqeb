/**
 * Whether a custom domain may have a certificate: a reverse proxy issuing certificates on demand asks
 * `GET /api/custom-domain?domain=<host>` before each one, as Caddy's
 * `on_demand_tls { ask … }` does, so a stranger's domain pointed at the
 * server gets none. A domain a published status page holds answers 200, any
 * other 404, and no open database 503, plain text and never cached. An
 * unpublished page's domain answers 404, so the address reveals no page a
 * visitor could not find.
 */

import type { Storage } from "@/server/storage/storage.ts";
import { customDomainOf } from "@/shared/schemas/page.ts";

/** What the question reads: the pages, nothing else. */
export interface CustomDomainStorage {
  readonly pages: Pick<Storage["pages"], "list">;
}

/** What the proxy's question came to. */
export type CustomDomainAnswer = "served" | "unknown" | "unavailable";

/** Whether a published status page holds the domain the text names, compared in a custom domain's stored form. Text that names no domain never reaches the database. */
export async function customDomainServed(
  storage: CustomDomainStorage | undefined,
  domain: string | null
): Promise<CustomDomainAnswer> {
  if (!storage) {
    return "unavailable";
  }
  const asked = customDomainOf(domain ?? "");
  if (asked === undefined) {
    return "unknown";
  }
  try {
    const pages = await storage.pages.list();
    return pages.some((page) => page.published && page.customDomain === asked)
      ? "served"
      : "unknown";
  } catch {
    return "unavailable";
  }
}

const answers: Readonly<
  Record<CustomDomainAnswer, { status: number; text: string }>
> = {
  served: { status: 200, text: "OK" },
  unavailable: { status: 503, text: "Service Unavailable" },
  unknown: { status: 404, text: "Not Found" },
};

/** The answer to the proxy: 200 `OK`, 404 or 503, plain text, never cached; a `HEAD` gets no body. */
export function customDomainResponse(
  answer: CustomDomainAnswer,
  method: string
): Response {
  const { status, text } = answers[answer];
  return new Response(method === "HEAD" ? null : text, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
    status,
  });
}
