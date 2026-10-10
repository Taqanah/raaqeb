/**
 * Where a docs page's Markdown copy lives: the page's own address with
 * `.md`, so an agent reading /en/docs/checks/http fetches
 * /en/docs/checks/http.md. The docs home, the page with no slugs, is
 * /en/docs/index.md.
 */

/** The address of the Markdown copy of a page, given its address and slugs. */
export function markdownUrl(page: {
  readonly slugs: readonly string[];
  readonly url: string;
}): string {
  return page.slugs.length === 0 ? `${page.url}/index.md` : `${page.url}.md`;
}

/** The slugs of the page whose Markdown copy the `.md` route's splat names. */
export function slugsOfMarkdown(splat: string | undefined): string[] {
  return !splat || splat === "index" ? [] : splat.split("/");
}
