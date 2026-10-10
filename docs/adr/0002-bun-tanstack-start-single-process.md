---
status: accepted
---

# Bun and TanStack Start as one process, with SQLite through Drizzle

Raaqeb runs as a single Bun process: the check scheduler, the database, the HTML pages, the JSON API, incoming webhooks and heartbeats all live in one TanStack Start application served by `Bun.serve`. No second HTTP library (Hono, Elysia) is added, because Start's server core already ships an HTTP layer (h3 version 2 on srvx) and its file routes carry JSON handlers, middleware, cookies and streaming. A footprint measurement of this shape inside a memory-capped container gave 24 to 32 MB idle for a static shell and 52 MB idle for full server rendering, so the runtime preference (Bun, TypeScript, TanStack) survives the floor and Go or Rust are not needed.

## Decisions bundled here

- **Runtime:** Bun, TypeScript. Checks and timers stay on the one event loop; worker threads cost 25 to 40 MB each.
- **Server and routing:** TanStack Start (React) on Vite, run through a hand-written `Bun.serve` entry that imports the Start fetch handler and preloads client assets into memory. Every route, admin and public, is server-rendered per request with Start's defaults and hydrated in the browser. Public responses are kept in the in-process memo and served from it until the change counter or the UTC date moves; admin pages are rendered per request and never memoised. There is no build-time prerender and no SPA shell, because neither can render pages whose content lives in the database.
- **Data access:** Drizzle ORM over `bun:sqlite` by default and Bun's native Postgres driver as an optional backend; raw SQL allowed on hot paths. Drizzle table builders are dialect-specific, so there are two schema files, one per dialect, kept identical in tables and columns by a test and written to the lowest common denominator of both dialects.
- **Validation:** Zod 4.5 or later, one schema per entity shared by server routes, the forms and the hand-written OpenAPI document. A test validates that document against the OpenAPI 3.1 schema with `@seriousme/openapi-schema-validator`, a dev dependency that ships in no build.
- **Client state and forms:** TanStack Query is not used; the public page's live refresh invalidates the view's own route match (ADR-0006). TanStack Form is not used either: each form is one draft in React state turned into its input through the shared Zod schema, and the library waits on the deferred list with the trigger that brings it back. TanStack Table is deferred.
- **Authentication:** Better Auth rather than a hand-written session layer, with one operator account in v1. Better Auth has had 20 GitHub security advisories in about a year and a half, several in the core; the trade accepted is dependency surface for passkeys, two-factor and OIDC without writing them. Pin versions and watch advisories.
- **UI:** shadcn/ui on Base UI (`@base-ui/react`) with the registry's RTL option, Tailwind CSS v4 logical utilities only, self-hosted Arabic font, pure SVG for the day bar and sparklines on public pages. Visual direction is ADR-0009.
- **Email:** nodemailer for the email channel's SMTP transport, imported only when an email channel sends, since Bun has no SMTP client. SMTP is the only transport; provider APIs are not used, since each provider takes SMTP. Measured cost: about 25 MB on import and a plateau near 72 MB after many sends, against about 47 MB for a hand-written client.
- **Distribution:** a multi-architecture Docker image plus compiled binaries from `bun build --compile`: Linux for x64 and arm64, each on glibc and on musl (Bun 1.4.2 no longer builds an x64 baseline binary), a macOS binary for Apple Silicon and Windows binaries for x64 and arm64. The image carries the glibc binary. The Windows and macOS binaries are unsigned by a publisher; the macOS one carries the ad-hoc signature Bun writes as it compiles. An Intel Mac binary stays on the deferred list. The binary embeds the full Bun runtime, so it is about 88 MB on disk. No slim runtime exists.
- **Repository:** one package, folders for server, admin and public UI; no workspaces.

## Considered options

- Go or Rust single binary: leaner (12 to 25 MB idle) but the maintainers work in TypeScript and the measurement showed Bun fits with headroom.
- Hono or Elysia beside Start: rejected as a duplicated HTTP stack; the gaps (OpenAPI output, rate limiting, typed client) are small to hand-write.
- TanStack Router on plain Vite without Start: rejected because Start's per-route rendering gives crawlers real HTML on public pages without a second rendering path.
- Hand-written auth: rejected in favour of Better Auth's feature set.

## Consequences

- The client assets are embedded into the compiled binary with `bun build --compile --asset`, which Bun 1.4.2 documents for a whole directory tree.
- Server rendering loads React's server renderer into the process; the performance budget sets the pass line with that included.
- Every Better Auth upgrade is a security event to read, not a routine bump.
