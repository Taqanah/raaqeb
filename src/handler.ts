/**
 * TanStack Start's server entry: the fetch handler that Vite bundles into
 * dist/server/handler.js. Named handler.ts because Start's default entry name is
 * src/server.ts, which is the Bun.serve entry in this layout (ADR-0007);
 * vite.config.ts points Start here. Request-level middleware lives in
 * src/start.ts, not in this file.
 */
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import type { Peer } from "./server/boot/proxies.ts";
import type { BootSettings } from "./server/boot/settings.ts";
import type { PublicTarget } from "./server/pages/public.ts";
import type { Liveness } from "./server/scheduler/health.ts";
import type {
  CheckRequests,
  OutageRequests,
  SubscriberRequests,
} from "./server/scheduler/scheduler.ts";
import type { DatabaseOpener, Storage } from "./server/storage/storage.ts";
import type { PublicView } from "./shared/schemas/overview.ts";

/**
 * The request context the Bun.serve entry hands to every request through
 * `handler.fetch(request, { context })`: the open storage, or nothing on a
 * onboarding before the database screen and under `vite dev`, which never runs
 * the entry. Loaders and server functions read it from their `context`
 * (docs/deps/tanstack-router/docs/start/framework/react/guide/server-entry-point.md).
 * The boot settings ride beside it; under `vite dev` there are none. The
 * onboarding database screen tests and opens a database through the entry's
 * opener, and the storage it opens serves every later request. Behind the
 * operator middleware (src/routes/-admin.ts) a handler sees the storage as
 * open, with the Better Auth instance the session was read through. The
 * scheduler rides beside the storage: its liveness for `/health`, its
 * check requests for "check now", an acknowledged outage, its subscriber notifications for the
 * events and confirmations a route hands on. The public target is the page, locale
 * and view the entry resolved before the memo looked, so the route renders
 * what the memo keys. `holdOpen`
 * lets a handler that waits on the network ("test now") keep its request
 * past Bun's ten idle seconds.
 */
export interface RequestContext {
  readonly boot: BootSettings;
  /** Keeps this request's connection open for so many seconds without a byte; `server.timeout` on the entry's request. */
  readonly holdOpen: (seconds: number) => void;
  /** The page whose frame shows a not-found at this address, from the memo's pages index; nothing under `vite dev` or with no page. */
  readonly missingView?: () => PublicView | undefined;
  readonly opener: DatabaseOpener;
  /** The socket peer and whether it is a trusted proxy, by the trusted proxies this request was resolved with; nothing on a unix socket or under `vite dev`. */
  readonly peer?: () => Peer | undefined;
  /** The status page view, document, summary, badge or feed the request shows, as the entry resolved it for the memo; nothing for any other request. */
  readonly publicTarget: PublicTarget | undefined;
  readonly scheduler:
    | (Liveness & CheckRequests & OutageRequests & SubscriberRequests)
    | undefined;
  readonly storage: Storage | undefined;
  /** Whether the address is an unpublished page's, from the memo's pages index; nothing under `vite dev`. */
  readonly unpublished?: () => boolean;
}

declare module "@tanstack/react-router" {
  interface Register {
    server: { requestContext: RequestContext };
  }
}

export default createServerEntry({
  fetch: (request, options) => handler.fetch(request, options),
});
