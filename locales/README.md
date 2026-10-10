# Message catalogs

One PO file per locale, `ar` and `en`, both complete before merge (ADR-0003). Code carries message ids only; the words live here.

- Every message carries the `#. js-lingui-explicit-id` comment, so Lingui keeps the id as written instead of hashing it.
- An id is snake_case with an area prefix: `monitor_status_down`. The prefixes are listed in `scripts/catalog.ts`.
- Plurals are ICU `{count, plural, ...}` with every category the locale needs: six for Arabic (`zero one two few many other`), two for English (`one other`).
- `bun run catalog` checks both files, writes `message-ids.ts` and compiles the catalogs; `bun run catalog:check` only checks, and the gate runs it. Both then write `fallback.ts` (gitignored): the error notice's three words in each locale, taken from the compiled catalogs, for a document whose own read failed.

To translate: take the Arabic lines of `CONTEXT.md` as settled, choose any other word for the sense of the sentence (the one Microsoft, Apple and Mozilla share, else plain words), then open a pull request that edits the PO file. A translation platform arrives with the third language.
