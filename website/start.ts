import { createMiddleware, createStart } from "@tanstack/react-start";

/** Where the build renders the not-found page to write each locale's 404.html (vite.config.ts). */
const notFoundRenders = new Set(["/404", "/en/404"]);

// The not-found page answers 404, and prerender writes only a page that answers 200. The static host sends the 404 itself, so these two renders answer 200.
const notFoundPage = createMiddleware().server(async ({ next, pathname }) => {
  const result = await next();
  if (!notFoundRenders.has(pathname) || result.response.status !== 404) {
    return result;
  }
  // Read whole first, so the stream is done before the answer that replaces it.
  return new Response(await result.response.text(), {
    headers: result.response.headers,
  });
});

export const startInstance = createStart(() => ({
  requestMiddleware: [notFoundPage],
}));
