---
status: accepted
---

# Raaqeb's design language: direction B as the base, Rubik, and appearance settings as token scales

Raaqeb owns its design language. The components are shadcn copies on Base UI, edited in this repository, and the language is built on the shadcn and Tailwind CSS variables rather than on any registry style. The visual base is direction B, the one chosen of three explored directions: light-first, neutral, quiet. The typeface is Rubik, machine tokens are set in IBM Plex Mono, and the four things an operator may adjust (theme, font size, density, radius) are scale variables over the tokens, so nothing hard-codes a padding or a radius.

## Decisions bundled here

- **Primitives.** shadcn copy-in on Base UI (`@base-ui/react` 1.8) with Tailwind CSS v4 logical utilities, components owned and edited here. No styled npm library. React Aria Components go on the deferred list with reopen triggers.
- **Base direction B.** Light-first, the website's neutrals tinted toward the teal in OKLCH with no pure black or white, rounded-xl cards, a teal primary button (`#0f766e` with white text in both themes) with a soft hover ring, a floating grey sidebar panel with grouped navigation, calm 14 px type, and one large chart on the monitor detail under uptime figures that stand over hairlines, not in tiles. Cards, the framed table and the sidebar sit on a near-invisible rim with a soft shadow instead of a 1 px border. Checked checkboxes, radios, switches and the choice card around one are teal too. Tabular figures apply only where numbers must line up, never to the whole document, because Rubik's tabular parentheses widen every zone label. A status badge is its coloured mark and the bare word, not a soft tint. The monitors list has one display, the framed table.
- **Taken from the other two directions.** A's dense list-and-detail split view becomes the compact mode, and its visible shortcuts on actions stay. C's Arabic type hierarchy is adopted: headlines larger and heavier, weight contrast inside rows, generous line height, and the plain-language public banner.
- **Typeface Rubik**, self-hosted, OFL, variable weight with the Arabic subset and Latin in the same file. IBM Plex Mono stays for machine tokens.
- **Appearance settings, per install.** Theme (system with a manual override), font size (small, medium, large; base 14 px), density (compact, comfortable default, spacious) and radius (none, medium default, large), implemented as four scale variables over the design tokens. One setting for the whole install, not one per operator. Light and dark are designed together from the start, and dark is an inversion with the same restraint. Public visitors get theme only, stored in their browser; the rest of a page's look is that page's customization.
- **Keyboard, v1.** Ctrl or Cmd+K opens the command palette, which is also the search; Ctrl or Cmd+B toggles the sidebar; N creates a monitor from the monitor list; `/` focuses search; `?` shows the shortcut sheet; Escape closes. Bindings are physical key codes, so Arabic layouts work. Ctrl or Cmd+S saves the form holding the focus, in a field or out of it, by pressing that form's Save.
- **Motion.** CSS transitions and the View Transitions API carry hover, press and open states everywhere in the admin. The `motion` package is used only for a named admin interaction that CSS cannot do. The public page carries no motion library at all.
- **Density target.** The console holds about eight monitors on an 800 px screen in the default view, and far more in compact mode.
- **Design base.** Direction B, the shared brief and the design assets are the design base.
- **Not fixed here:** the five default status colours, and which Rubik and Plex Mono files and weights are bundled.
- **One habit banned.** No English word in parentheses beside an Arabic label; the explored directions produced them. The Arabic-first rules apply unchanged.

## Considered options

- **The eight shadcn Base UI registry styles as the design** (nova, vega, lyra, luma and the other four). Rejected: a registry style is a starting radius and shadow, not a design language, and a first design built on stock nova was judged not publishable. The diagnosis was the missing design language, not the primitives.
- **A styled component library.** HeroUI 3.2.5 is React Aria plus Tailwind v4 from npm with no motion dependency, but its own discussion #6061 says several components still assume LTR. Coss UI is on Base UI and Tailwind v4 and absorbed Origin UI, but it is AGPL. Both rejected in favour of owning the components.
- **React Aria Components** in place of Base UI. It detects direction and locale automatically and ships Arabic strings, against Base UI 1.8's two open RTL items and a DirectionProvider that does not read `dir`. Deferred rather than rejected, because the primitives were not what fell flat.
- **IBM Plex Sans Arabic** as the interface face. Rejected after seeing both faces live on the directions.
- **Direction A or C as the base.** A is denser and more keyboard-forward, C has the strongest Arabic typography. Both lost to B on restraint, and each kept the contribution named above.
- **Fixed design tokens.** The simplest thing, and refused because the operator must be able to adjust theme, size, spacing and radius.
- **Per-operator appearance settings.** Rejected: with one operator account in v1 they are the same thing with more state.

## Consequences

- Nothing in the admin hard-codes a padding, a radius or a font size. A component that does breaks an appearance setting.
- Owning the shadcn copies means upstream fixes are read and applied by hand. The Base UI Switch thumb sliding the wrong way under `dir="rtl"` is shadcn-ui/ui#10274, still open, worked around with a mirror transform.
- Ctrl+N cannot be intercepted in Chrome, so new monitor is the bare N, and Ctrl+P is left to print.
- Direction B is a base and not the end: it is the best of the three directions and still needs a lot of work.
- An interactive prototype and a reference library of admired dashboards are out of scope; design happens in the build. The written design language (tokens, Arabic and Latin type scale, spacing rhythm, status colours, motion, keyboard map, appearance scales) is the output of the first design work.
