# Raaqeb

Raaqeb (راقب, "keep watch") is a source-available (FSL-1.1-ALv2), self-hosted, single-tenant monitoring and status page tool. One monitor runs on 1 vCPU and 240 MB RAM with no external service. Arabic first (default locale `ar`, RTL), with i18n for other languages. The bar is polish in every detail.

`CONTRIBUTING.md` holds setup, the pull request process and the CLA. This file holds how to write code here. `CONTEXT.md` is the glossary and `docs/adr/` holds the decisions.

## Philosophy

Ambitious ideas, simple systems, software that feels obvious. Find the real constraint, then the smallest model that makes correct behaviour unsurprising. Bun and the platform before a dependency, the standard library before custom code, one line before fifty.

## Before you write code

1. Read `CONTEXT.md` and name every domain concept with its glossary word. A concept with no word means you are inventing language: say so in the pull request instead of coining a term.
2. Read the ADRs in `docs/adr/` that touch your area. A change that contradicts one says so in the pull request body.
3. Ask when two readings of the issue would produce different work.

## Layout

One package, no workspaces (ADR-0002). ADR-0007 holds the layout and import rules; Biome fails the build on a violation.

```
src/server.ts   the raaqeb command and the Bun.serve entry
src/handler.ts  Start's server entry
src/start.ts    request middleware, CSRF, error logging
src/routes/     TanStack Start file routes: parse, check auth, call one module. A file starting with `-` is shared and is not a route
src/server/     the deep modules, one folder per domain area
src/admin/      admin UI, one folder per feature
src/public/     status page UI
src/shared/     Zod schemas, pure domain rules, i18n, ui primitives, the OpenAPI document
locales/        ar (source) and en message catalogs
website/        public website: its own Vite root and TS program, imports `src/shared/` through `@/` and nothing else of `src/`
```

- **Direction:** `routes -> server`, `routes -> admin | public -> shared`. The UIs never import `server/`, `server/` never imports a UI or `routes/`, and `shared/` imports nothing above it. This keeps the browser bundle free of server code.
- **Storage is sealed.** Only `server/storage` imports Drizzle or a driver, so the two backends stay swappable. The one exception is `server/checks/database-io.ts`, which opens `Bun.SQL` to reach a monitored database, never Raaqeb's own.
- **Import the file you want.** Barrel files fail lint. A same-folder or lower import is relative (`./draft.ts`); going up a folder uses `@/` for `src/`, and lint refuses `../`. Every path carries its extension. Inside `website/`, going up uses `~/`.
- **Deep modules.** Each folder under `server/` is a small interface hiding a large implementation: grow the implementation, not the interface. A repository speaks domain words (`monitors.dueAt(now)`), never query-builder terms, and never returns a Drizzle row type. One repository per aggregate in `CONTEXT.md`.
- **Pure where it can be.** `checks`, `status` and `shared/domain` do no I/O; `now` is a parameter, so tests need no clock.
- **Optional capabilities** sit under `server/capabilities/<name>/`. Core code reaches them only through the registry's dynamic `import()` (ADR-0001).
- **DDD here means language and boundaries.** Folders named entities, value-objects, use-cases, ports or adapters do not exist.

## Database parity

SQLite and Postgres work under one rule: a feature works on both or on neither.

- `src/server/storage/schema/sqlite.ts` and `postgres.ts` change in the same commit; `schema/parity.test.ts` fails on a difference.
- A migration lands under both `migrations/sqlite/` and `migrations/postgres/`. `bun run db:generate <name>` writes both. Hand-write only what the generator cannot: a data step such as a seed row, and `WITHOUT ROWID` on a SQLite head table.
- Columns are the lowest common denominator: JSON as text, timestamps as integer milliseconds (`bigint` on Postgres), booleans as integers, packed blobs as `blob` and `bytea`. Every day boundary is UTC.

## The test-first loop

Anything with logic is written test first, one commit per step, so a reviewer can replay the work (ADR-0008). Tests are committed before the code they test.

1. **Interface.** Exported signatures and types, no bodies. Done when `bun run typecheck` accepts the file and every name is a `CONTEXT.md` word.
2. **Red** (`test:`). Tests against that interface, named by the behaviour they pin in glossary words, never by the function they call. Done when each fails for the reason its name gives.
3. **Green.** The smallest code that passes, test files untouched. Done when the suite is green.
4. **Audit** (`test:`). Re-read every test against the issue, not the code. A test changes only when it asserts something the issue never asked for or contradicts `CONTEXT.md`; list each changed assertion with its reason in the pull request body.
5. **Harden.** Add the edge cases you met, then break the code: for each behaviour, flip one condition, watch a test go red, restore it. A behaviour that stays green has no test yet.
6. **Gate.** Both gate commands are green (below).

A bug starts at red: a failing test reproduces the report before any fix. A test that fails stays as written; "fixed" means the same test, green.

Tests sit in `<name>.test.ts` beside `<name>.ts`. Integration tests use a real SQLite file in a temp directory. Styling and copy have no tests. Playwright specs in `e2e/` walk every flow an operator or visitor finishes in the browser, each test on records it creates or on an install of its own, never on a seeded record another spec reads: `retries: 0`, `@playwright/test` pinned exactly, `expectPath(page, "/...")` never a regex `toHaveURL`, every `expect.poll` awaited, selectors are attributes (`input[name=email]`) never Arabic copy.

## The gate

```
bun run gate                    catalog check, lint, typecheck, unit and integration tests on SQLite
docker compose up -d            a local Postgres, Mailpit for the email channel, MySQL and Redis for the database monitors
bun run test:postgres           the same integration files against Postgres, Mailpit, MySQL and Redis; a missing service fails the run
bun run e2e:install && bun run e2e    Playwright specs: the full suite once when your work is done, only the spec of your red test while working
```

`bun run fix` formats; formatting is never a review topic. A change an operator or visitor can see or click is done after you have used it in the built app (`bun run build`).

## Arabic first

- Default locale `ar`, layout RTL. Use Tailwind logical utilities (`ms-`, `pe-`, `start-`); physical ones (`ml-`, `pr-`) break RTL.
- Every user-visible string crosses `shared/i18n` (ADR-0003); a literal in a component is a bug. `ar` is the source catalog and `en` stays complete. `bun run catalog` regenerates `message-ids.ts` and `fallback.ts` in `locales/`.
- Western digits 0 to 9. Dates follow the calendar setting, Gregorian by default.
- Machine tokens (URLs, codes, IDs) stay LTR in a monospace font.
- Write Arabic copy as Arabic: verb first where Arabic puts it there, one word for one sense across the product, no calques of English idiom. Reuse the Arabic line `CONTEXT.md` gives a term. A new term whose Arabic you are unsure of goes in the pull request for a native speaker to confirm.
- The line under a choice (select, segmented, radio, option cards) is true of the option selected. A switch's line says what turning it on does, or holds in both states. A line under a disabled control says why it is disabled.

## Code rules

- No `any`. No `as` outside a parse boundary. A `@ts-expect-error` carries a comment naming the upstream issue.
- Dependencies are exact-pinned. Adding or removing one belongs in an issue first.
- Bun before a dependency. `node:` imports fail lint; when Bun has no equivalent, put `// biome-ignore lint/style/noRestrictedImports: <why Bun has none>` above the import. `rg "noRestrictedImports" src` lists the exceptions.
- Comments explain why, in one line.
- Prose in plain words, no em-dashes, no emoji.
- Print an environment variable's name and length, never its value.
- `bun run check` has zero errors. Read `node_modules/` for the installed version of Better Auth or TanStack before asserting how an API behaves; both move fast. `bun run docs:pull` fills a local docs mirror.

## Commits

Conventional Commits (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`), subject in the imperative under 72 characters, the body says why. One branch per issue off `main`, named `<number>-<slug>`.

## Gotchas

Check the installed version before relying on one.

- **`createStart()` drops TanStack's default CSRF middleware.** `src/start.ts` re-adds `createCsrfMiddleware`; an end-to-end spec pins it.
- **Server functions return a result object and never throw.** Start's error plugin strips custom properties off `Error` in transit, and in production an uncaught error reaches the client with absolute file paths. Reason codes (ADR-0004) travel in the result.
- **Hydration.** Read state and browser checks in an effect after mount, never in render scope (ADR-0006).
- **Better Auth swallows mail transport errors** and still answers success. The email channel reports its own failures.
- **`Bun.password.verify` throws on a malformed hash** instead of returning false.
- **A `$` in an `.env` value is escaped** (`ab\$cd`).
- **Binaries from `node_modules/.bin` run on Bun** through `bunfig.toml` (`[run] bun = true`); without it Vite's node shebang starts Node and every `Bun.*` call dies.
