/**
 * A rendered document made still: served as it is at any address, it never
 * hydrates, so it carries no script but those its head writes before first
 * paint (a status page's theme), and no module preload. Bun's HTMLRewriter
 * does the cutting as the body streams through.
 */

const removed: HTMLRewriterTypes.HTMLRewriterElementContentHandlers = {
  element: (element) => {
    element.remove();
  },
};

/** The document without the scripts the app hydrates with and their preloads. */
export function stillDocument(response: Response): Response {
  return new HTMLRewriter()
    .on("link[rel=modulepreload]", removed)
    .on("script[src]", removed)
    .on("body script", removed)
    .transform(response);
}

/** An access page with the line that says why a try failed shown, and the password field marked as refused and focused. */
export function withAccessLine(
  response: Response,
  line: "access-limited" | "access-wrong"
): Response {
  return new HTMLRewriter()
    .on(`[data-slot=${line}]`, {
      element: (element) => {
        element.removeAttribute("hidden");
      },
    })
    .on("input[name=password]", {
      element: (element) => {
        element.setAttribute("aria-invalid", "true");
        element.setAttribute("autofocus", "");
      },
    })
    .transform(response);
}

/** The document with its language switch leading to `href`. */
export function withLocaleSwitch(response: Response, href: string): Response {
  return new HTMLRewriter()
    .on("a[data-slot=page-locale]", {
      element: (element) => {
        element.setAttribute("href", href);
      },
    })
    .transform(response);
}
