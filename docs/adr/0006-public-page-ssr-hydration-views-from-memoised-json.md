---
status: accepted
---

# Public status page: server-rendered and hydrated, every view rendered from its memoised JSON document

The public status page is a TanStack Start route tree in the default `ssr: true` mode. The first response is finished HTML from the in-process memo; React hydrates in the background and the router takes over navigation from there. Every public view (overview, incident history for a month, one incident, one maintenance) has a JSON document under Raaqeb's own public API, and that document is the only source the view renders from: the route loader builds it in-process during server rendering and fetches its URL from the browser on navigation and on poll. The HTML and the API cannot disagree because they are the same data.

## Decisions bundled here

- **Hydration on.** The public page ships React, the router and its route code. The first paint needs none of it; hydration only adds behaviour. Server Components are not used: TanStack Start marks them experimental and they need a separate Vite plugin. They are on the deferred list with a re-evaluate trigger.
- **One JSON document per view, read by the loader on both sides.** During server rendering the loader calls the same function that produces the JSON, so the memoised HTML is one database read per change. In the browser the loader fetches the document's URL, which is itself memoised and answered with a 304 while nothing changed. No public loader calls a server function that reads the database.
- **Client-side navigation** between the views of one status page, the Start default. Every navigation is a JSON fetch through the memo. The language switcher is the one link that forces a full document load, because each rendered locale inlines its own message catalog (ADR-0003).
- **Live refresh** re-reads the current view's document every 60 seconds and on window focus, stopped while the tab is hidden. Every refetch carries the memo's ETag, so an unchanged view costs the server a hash comparison. The view invalidates its own route match and the browser's cache sends the ETag; the public page loads no TanStack Query.
- **Subscribe form** submits through a server function once hydrated. It has no plain-POST fallback; a `<noscript>` line inside the form says JavaScript is needed to subscribe by email or webhook and links the Atom feed, which is a plain link.
- **Theme** is three-state (system, light, dark), kept in local storage and applied by an inline script in `<head>` before first paint. With nothing in local storage the fallback is the page's own theme default from its customization, not the system setting. Never sent to the server, so there is still one rendered document per locale.
- **JavaScript size** of the public route is measured by the floor benchmark, not gated. A build-time size gate is on the deferred list.

## Considered options

- **No hydration: finished HTML plus a few small scripts of our own** (relative time, ETag poll and reload, theme). Smallest possible page for a visitor on a slow phone. Rejected: the hydrated page gives the same first paint from the memo and adds in-place refresh, a real form and router navigation without a second, hand-rolled client layer.
- **Islands: hydrate only the subscribe form and the toggle.** Start has no islands mode; it would mean a second entry bundle maintained by hand. Rejected.
- **Server Components.** Experimental in Start today. Deferred.
- **Loaders calling server functions that read the database.** Simplest to write, but every poll from every open tab and every navigation becomes a query, which is the load the memo exists to avoid. Rejected.
- **Full document loads on every link.** Keeps the memo as the only path with nothing else to think about. Rejected in favour of the Start default; the JSON-per-view rule keeps navigation on the memo anyway.
- **Poll and reload the whole page on ETag change.** Works without hydration; pointless once the page is hydrated. Rejected.

## Consequences

- The public API is shaped by the page: each view's document carries everything that view shows and nothing more. The Statuspage-compatible summary stays a separate memoised endpoint for aggregators.
- The memo wrapper must buffer Start's streamed response to a full body before hashing it for the ETag and storing it; the dehydrated loader data inside that body is stored and hashed with it.
- Relative times render as an absolute `<time datetime>` on the server and switch to relative text in an effect after mount, never during render, so hydration sees the server markup unchanged. The same rule applies to anything that depends on local storage, the visitor's time zone, the current time or the viewport. The visitor's time zone is on that list because timestamps render in the browser zone; there is no per-page time zone mode.
- The public and admin routers are one Start app. Route-level code splitting keeps admin code out of the public bundle; the floor benchmark's size measurement is the check that it stays so.
- A visitor without JavaScript sees the current state of the page and can read everything, follow links and read the feed, but cannot subscribe by email or webhook and does not see in-place updates.
- Reverting to a no-hydration page later is a matter of removing the client entry from the public root and adding the small scripts back; the JSON-per-view contract and the memo stay as they are.
