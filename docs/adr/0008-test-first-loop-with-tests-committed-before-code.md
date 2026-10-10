---
status: accepted
---

# Test first for everything with logic, tests committed before code, test changes reviewed on their own

Every piece of Raaqeb with logic is written test first, in a fixed loop whose steps are separate commits: interface, red, green, audit, harden, gate. Tests are committed before any implementation, so the reviewer can diff the test files between the red commit and the head of the branch and read every change made to a test after the code existed. A test may change after red only when it asserts something the ticket never asked for or contradicts `CONTEXT.md`, and each such change is listed in the PR body with its reason. Loosening or deleting an assertion to reach green is forbidden.

This record holds why the steps are shaped this way.

## The problem this solves

An agent writing tests after the code writes tests that pass, not tests that pin behaviour. Plain test-first fixes that and introduces two further problems: the agent may not know what the implementation will look like, so the tests aim at the wrong shape; and the implementation reveals edge cases the tests did not foresee. The loop answers both without giving the agent a way to bend the tests to the code.

## Decisions bundled here

- **Interface first.** The deep-module rule (ADR-0007) says small interface, large implementation. The agent writes the exported signatures and types before the first test, so the tests aim at the interface and never need to know the implementation. This is the answer to "we cannot test what we have not designed": design the interface, which is small, and leave the implementation hidden.
- **Scope: everything with logic.** Domain rules, repositories on both backends, routes, notification delivery, i18n formatting, schemas, and every bug fix (the failing test reproduces the report first). Styling and copy have no tests. Every flow an operator or visitor finishes in the browser has a Playwright spec, because an operator finishes every flow in the browser, never only through the API or the command line, and because the browser run catches what the unit tests cannot: a spec left stale by a design change, a page wider than a phone, a refusal in the browser's language. A change a user can see passes `bun run e2e` before merge, run once when the work is done rather than after each change.
- **Tests as their own commit before code.** The red state is in history. Review reads `git diff main...HEAD -- '*.test.ts'` on its own before reading the code, and every test changed after the red commit is explained in the PR body. This is the check that turns "the agent should not change tests to go green" from a request into something a reviewer can see.
- **Audit against the ticket, not the code.** After green the agent re-reads each test against the ticket and `CONTEXT.md`. A wrong test is corrected there, in the open; a right test that the code fails means the code changes.
- **Harden with a break-it check.** Edge cases found while implementing get tests. Then, per behaviour, the agent flips one condition in the code, confirms a test goes red, and restores it. A behaviour that stays green when broken has no test. This is manual mutation testing; the tooling is on the deferred list.
- **Fast suite, Postgres run apart.** `bun test` runs unit and integration tests against SQLite with no services, on every save. The same integration files run once more against the compose Postgres as a required step before merge. A missing Postgres fails that run rather than skipping it, because a skipped parity test is a passed parity test to a reader.
- **Two review passes.** The agent reviews its own diff, then the human. Cross-model review is on the deferred list.

## Considered options

- **Tests after, before merge.** Rejected: the failure mode described above.
- **Test-first for domain logic and bug fixes only** Rejected in favour of everything with logic.
- **Testcontainers for Postgres.** Reported to hang intermittently under `bun test`, and the compose file is already the local Postgres. Rejected.
- **Postgres inside the Playwright step.** Wrong tool; the same `bun test` files with a different `DATABASE_URL` cost nothing extra. Rejected.
- **Mutation testing with a Stryker runner for Bun now.** Two third-party runners exist on npm, neither proven on this project. It is on the deferred list with a trigger; the break-it check covers the gap.

## Consequences

- A PR carries at least four commits (interface, test, code, test or hardening), which is what lets the reviewer replay the work.
- Test names are behaviours in glossary words, so a failing test reads as a sentence about the product.
- The gate has two commands, `bun run gate` and `bun run test:postgres`, and a merge needs both green.
- If the beside-the-file placement (ADR-0007) turns out to hide tests from reviewers, the mirrored-tree alternative is a move of files with no change to this loop.
