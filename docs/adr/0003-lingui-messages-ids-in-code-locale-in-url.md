---
status: accepted
---

# Lingui for interface messages, ids only in code, locale in the URL on public pages

Interface text is formatted by Lingui 6 (`@lingui/core`, `@lingui/react`, `@lingui/cli`) from one PO message catalog per locale, with Arabic as the source locale and English complete from day one. Code carries message ids only (`monitor_status_down`), never language text; the Arabic catalog is edited by hand like every other language. Plural category selection, dates, numbers and units come from the runtime's `Intl` objects, so the library's job is message storage, typing and the translator workflow.

Three candidates were run under Bun 1.4.2 with the same six-category Arabic plural. All three selected the categories correctly, formatted in plain server code with an explicit locale, and embedded in a `bun build --compile` binary. The choice turned on tooling behaviour, not on formatting.

## Decisions bundled here

- **Message ids in code, text in catalogs.** Lingui's native flow extracts source text from code, but Arabic literals inside TypeScript are awkward to edit. Ids are snake_case with an area prefix.
- **Catalogs** live at `locales/<locale>/messages.po`, one folder at the repository root. PO is the format Weblate and Crowdin read natively; v1 contribution is a pull request on that file.
- **Completeness gate.** `lingui compile --strict` fails the build on a missing translation in any shipped locale. A repository lint, written by Raaqeb, fails the build when a plural message lacks a category its locale requires (six for Arabic). No shipped locale is ever partial, so runtime fallback never fires in a release.
- **Typed ids.** A generated union of message ids is checked in beside the catalogs so a typo fails `tsc`. Message arguments stay untyped strings; Lingui offers nothing better.
- **Locales** are `ar` and `en` only. Regional tags in `Accept-Language` collapse to the base for matching; URLs and settings accept bare tags.
- **Public status pages** carry the locale in the URL: the page language at the plain address, the other under a locale prefix, linked by `hreflang` alternates. No cookie, no redirect by `Accept-Language`. Both locales of a page are rendered documents.
- **Admin area** uses the operator language, defaulting to the install language. The first-run page opens in Arabic with a switcher; the install language is a field there, Arabic by default, changeable in settings. The root route's loader reads the operator language from the database, and the server-rendered document inlines that locale's catalog.
- **Server-side text.** Operator notifications use the channel language, which defaults to the install language and can be set per channel. Subscriber notifications use the subscription language, recorded from the locale of the page address the subscriber signed up from; a feed is in the locale of its own address. Generic webhook payloads are machine values and are never localized.
- **Build transform.** None. Call sites carry ids only (`i18n._(id)`, `<Trans id>`), which needs no macro, so `@lingui/babel-plugin-lingui-macro` is not installed. It is the plugin to add if a macro is ever used, because TanStack Start's template runs the Babel React plugin; the Rust SWC plugin is not used.

## Considered options

- **FormatJS** (`@formatjs/intl`, `intl-messageformat`, `@formatjs/cli`): the largest community and the best translator-platform support, and its runtime is pure JavaScript. Rejected because `@formatjs/cli` 6.16 is a Rust native binary with no JavaScript fallback that fails to load under Bun on glibc Linux, then exits 0 with an empty catalog; with a library preload it loads but still swallows ICU syntax errors under Bun. A silent zero-exit compiler is the one failure an Arabic-first project cannot accept, and the fix is a Node install in CI for one command. Re-evaluate when the CLI loads and fails loudly under Bun.
- **Paraglide JS** (`@inlang/paraglide-js`): the tightest typing (generated functions with typed arguments), no build transform, per-message tree-shaking, and the only official TanStack Start integration. Rejected because it compiles a missing translation or a missing plural category with no warning and no strict flag, then prints the raw key at runtime; its compiler pulls a 338 MB native dependency per platform; no translation platform lists its format and inlang's own editor was closed as not planned; and the company's stated focus has moved to another product. Re-evaluate on a strict compile mode, a maintained editor, and a year of steady releases.
- **Plain `Intl` with a typed TypeScript message map**: zero dependencies and `tsc` as the validator, but translators would edit TypeScript and Raaqeb would maintain its own interpolation and plural helpers. Kept as the fallback: PO catalogs convert to it mechanically.
- **i18next, Fluent**: ruled out on runtime size, untyped keys, or runtime file loading that does not fit a compiled binary.

## Consequences

- Raaqeb owns two small tools: the plural-category lint and the id-union generator. Both read the PO catalogs and run in CI.
- Every message is written twice before merge, Arabic and English, in the same pull request.
- A future switch to FormatJS or Paraglide is a catalog conversion plus a call-site rewrite, because both speak ICU-shaped plurals and the code holds ids only; the domain terms in `CONTEXT.md` (locale, install language, page language, channel language, subscription language, message catalog) do not depend on the library.
- The Vite pipeline gains no Lingui transform. Should a macro ever be needed, the Babel plugin is one more transform, and if Start moves its template to the SWC React plugin, Lingui's Rust plugin exists but carries no semver guarantee against `swc_core`.
