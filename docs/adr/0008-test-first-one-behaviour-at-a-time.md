---
status: accepted
---

# Test first, one behaviour at a time, and the break proven by a flip

Every piece of Raaqeb with logic is written test first. A feature goes one behaviour at a time: a failing test at the highest seam that reaches the behaviour, the least code that passes it, then the next behaviour. A bug starts with a failing test that reproduces the report, committed before the fix. When the code works it is attacked and swept: the builder answers a fixed list of hostile questions, then flips each operator on the lines the branch changed and gives every flip no test noticed a test or a reason. A test may change after it first passed only when it asserts something the ticket never asked for or contradicts `CONTEXT.md`, and each such change is listed in the PR body with its reason. Loosening or deleting an assertion to reach green is forbidden.

This record holds why the steps are shaped this way. It replaces a fixed loop of six steps with a commit each (interface, red, green, audit, harden, gate); "What changed" says why.

## The problem this solves

An agent writing tests after the code writes tests that pass, not tests that pin behaviour. Writing the test first fixes that. It does not fix a test that passes for the wrong reason, which only breaking the code shows, and it does not make the builder ask the questions an attacker would.

## Decisions bundled here

- **One behaviour at a time.** A test, its code, the next test. Writing every test before any code aims the tests at an implementation nobody has met yet: they come out shaped like the plan, and the first surprise bends them.
- **The highest seam.** A behaviour is pinned once, at the seam nearest to what an operator or visitor observes that still reaches it. The same behaviour pinned at the repository, the route and the browser is three tests to change for one behaviour protected. The deep-module rule (ADR-0007) keeps the seams few: the interface is small, and the tests never need to know the implementation.
- **Scope: everything with logic.** Domain rules, repositories on both backends, routes, notification delivery, i18n formatting, schemas, and every bug fix. Styling and copy have no tests. Every flow an operator or visitor finishes in the browser has a Playwright spec, because an operator finishes every flow in the browser, never only through the API or the command line, and because the browser run catches what the unit tests cannot: a spec left stale by a design change, a page wider than a phone, a refusal in the browser's language. A change a user can see passes `bun run e2e` before merge, run once when the work is done rather than after each change.
- **A bug's test is its own commit, before the fix.** The red state is in history, so "fixed" means the same test, green. A feature's tests and code arrive together, one behaviour at a time, and its commits follow the pieces of the work.
- **Test changes are reviewed on their own.** Review reads `git diff main...HEAD -- '*.test.ts'` before the code, and every test changed after it first passed is explained in the PR body. This turns "do not change tests to go green" from a request into something a reviewer can see.
- **Attack before review.** The same kinds of defect kept reaching review with every test green: an input a client controls reaching a cache key or a loop bound with no cap; a secret echoed back by a hostile target into a stored detail; stale state failing open; a query fast on a fixture and quadratic on a day of history; a permission that reached further than its name said. The builder answers that list in the PR body, so the reviewer starts from the answers instead of finding the questions.
- **Break it with a tool.** `bun run flip` breaks one line, runs one named test and restores the file; with `--sweep` it does that for each operator on the lines the branch changed. A behaviour that stays green when broken has no test. Done by hand, the break was run against whole files, so a flip went red through another test's state; a mistyped pattern read as a pass; and a flipped loop condition hung the suite.
- **Fast suite, Postgres run apart.** `bun test` runs unit and integration tests against SQLite with no services. The same integration files run against the compose Postgres as a required step before merge when the change reaches a database; a change that does not runs there only the test files it touched, and the whole suite runs on Postgres again once a batch of changes is merged. A missing Postgres fails the run rather than skipping it, because a skipped parity test is a passed parity test to a reader.
- **One round of review.** The builder reviews its own diff, then one round of review follows, by more than one model when the change is large or touches a security path: different models found different defects, and a second round found little unless a fix had replaced a design.

## What changed

The first form of this loop had six steps, each its own commit: the interface, every test, the code, an audit of the tests, hardening, the gate. Used across about three hundred changes, it showed four costs:

- Every test before any code is the horizontal slice described above. The audit step existed to repair the tests it produced.
- A commit per step put five commits and as many reruns on a two-line fix. Reviewers read the test diff against `main`, not the steps.
- The break-it step, done by hand, reported behaviour as covered that reviewers then broke without a test noticing, in eight of thirty-two changes reviewed.
- The whole Postgres suite on every change took four to five minutes and found nothing in changes that touched no storage code.

## Considered options

- **Every test before any code, a commit per step.** The first form. Replaced for the reasons above.
- **Tests after, before merge.** Rejected: the failure mode this record opens with.
- **Test-first for domain logic and bug fixes only.** Rejected in favour of everything with logic.
- **Testcontainers for Postgres.** Reported to hang intermittently under `bun test`, and the compose file is already the local Postgres. Rejected.
- **Postgres inside the Playwright step.** Wrong tool; the same `bun test` files with a different database cost nothing extra. Rejected.
- **A mutation testing framework.** Two third-party runners for Bun exist on npm, neither proven on this project. The sweep is a literal table of operator swaps over the changed lines, small enough to read, and covers the gap.

## Consequences

- A bug fix carries a `test:` commit before its `fix:` commit.
- Test names are behaviours in glossary words, so a failing test reads as a sentence about the product.
- The gate has two commands, `bun run gate` and `bun run test:postgres`.
- If the beside-the-file placement (ADR-0007) turns out to hide tests from reviewers, the mirrored-tree alternative is a move of files with no change to this record.
