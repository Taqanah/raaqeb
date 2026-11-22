/**
 * The memo (CONTEXT.md "Memo"; ADR-0006): the in-process copy of
 * every public response, kept and served again until the change counter or
 * the UTC day moves. It stores a 200 GET whose route set `Cache-Control:
 * public` (a memo of not-founds stores their 404 instead, and never answers
 * one with a 304), buffered to a full body and hashed once for its ETag; everyone
 * asking for a key while it renders awaits that one render. Nothing runs
 * without a visitor: no timer, no expiry, no warm fill. Past the cap the
 * entry used longest ago goes, which costs one render later.
 */

/** What an entry was rendered at: it is served only while both still hold. */
export interface Validity {
  readonly counter: number;
  /** The UTC day's start, milliseconds. */
  readonly day: number;
}

export interface Memo {
  /**
   * The answer to a GET or HEAD for `key`: the stored entry while it is
   * valid, as a 304 when the request holds its ETag; otherwise one render
   * that every concurrent request for the key awaits, stored when it may
   * be. A render that may not be stored is answered as it came.
   */
  readonly respond: (
    request: Request,
    key: string,
    validity: Validity,
    /** Renders the key's answer; `refresh` says whether the memo held an entry for the key that went stale, else it fills a key it holds nothing for. */
    render: (refresh: boolean) => Promise<Response>
  ) => Promise<Response>;
  /** How many entries are kept. */
  readonly size: () => number;
}

/** Entries kept per status page: two locales of the four views as HTML and as documents, the summary, and the feed and the badge in each locale. */
export const entriesPerPage = 21;

/** The cap for so many pages: pages times locales times views plus the summary, the feeds and the badges; never under one page's worth. */
export function memoCap(pages: number): number {
  return Math.max(1, pages) * entriesPerPage;
}

const publicDirective = /(^|,)\s*public\s*(,|$)/i;

/** Whether a render may be stored: a 200 whose Cache-Control says public and that sets no cookie. */
export function isStorable(response: Response): boolean {
  const policy = response.headers.get("cache-control") ?? "";
  return (
    response.status === 200 &&
    publicDirective.test(policy) &&
    !response.headers.has("set-cookie")
  );
}

/** The strong ETag of a stored body: its SHA-256, cut to 128 bits, in hex. */
export function etagOf(body: Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  return `"${hash.slice(0, 32)}"`;
}

const weakPrefix = /^W\//;

/** Whether the request's If-None-Match names the ETag, weak, listed or `*`. */
export function holdsEtag(request: Request, etag: string): boolean {
  const held = request.headers.get("if-none-match");
  if (held === null) {
    return false;
  }
  return held
    .split(",")
    .map((tag) => tag.trim().replace(weakPrefix, ""))
    .some((tag) => tag === "*" || tag === etag);
}

/** A stored response: its body, the headers and status it is answered with, and what it was rendered at. */
interface Entry {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly headers: Headers;
  readonly status: number;
  readonly validity: Validity;
}

/** A render every request for the key awaits: the stored entry, or the response itself when it may not be stored. */
interface Rendering {
  readonly done: Promise<Entry | Response>;
  readonly validity: Validity;
}

const sameValidity = (a: Validity, b: Validity) =>
  a.counter === b.counter && a.day === b.day;

function answer(request: Request, entry: Entry): Response {
  const etag = entry.headers.get("etag") ?? "";
  // A 304 tells a cache its copy is the page, which a not-found is not.
  if (entry.status === 200 && holdsEtag(request, etag)) {
    return new Response(null, { headers: entry.headers, status: 304 });
  }
  return new Response(request.method === "HEAD" ? null : entry.body, {
    headers: entry.headers,
    status: entry.status,
  });
}

/** How long a request for a stale entry waits on its refresh before it is answered with the stale entry. */
export const staleWaitMs = 500;

/** A memo holding at most `cap()` entries, read at each store, of the renders `keeps` allows: by default a public 200 (`isStorable`). An entry keeps its render's status. A stale entry is answered while its one refresh runs, unless the refresh lands within `staleMs`. */
export function createMemo(
  cap: () => number,
  keeps: (response: Response) => boolean = isStorable,
  staleMs: number = staleWaitMs
): Memo {
  // A Map keeps insertion order: the first key is the one used longest ago.
  const entries = new Map<string, Entry>();
  const rendering = new Map<string, Rendering>();
  // The one refresh each stale entry has running, whatever the counter did since it began: the entry it stored, or why it stored none.
  const refreshes = new Map<string, Promise<Entry | "busy" | "gone">>();

  async function store(
    key: string,
    validity: Validity,
    response: Response
  ): Promise<Entry> {
    const body = new Uint8Array(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    headers.set("etag", etagOf(body));
    // Start's own length and encoding describe the stream it sent, not the stored body.
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    const entry: Entry = { body, headers, status: response.status, validity };
    entries.delete(key);
    entries.set(key, entry);
    for (const oldest of entries.keys()) {
      if (entries.size <= cap()) {
        break;
      }
      entries.delete(oldest);
    }
    return entry;
  }

  /** Starts the stale entry's one refresh, or joins the one running even when it began at an older validity, so a counter that keeps moving queues no second render of the key: the entry it stores; `busy` when the render had no turn, which keeps the stale entry; `gone` when the address answers something no longer kept, which drops it. */
  function refresh(
    key: string,
    validity: Validity,
    render: (refresh: boolean) => Promise<Response>,
    kept: Entry
  ): Promise<Entry | "busy" | "gone"> {
    const running = refreshes.get(key);
    if (running !== undefined) {
      return running;
    }
    const done = render(true).then(
      async (response): Promise<Entry | "busy" | "gone"> => {
        if (keeps(response)) {
          return await store(key, validity, response);
        }
        await response.body?.cancel();
        if (response.status === 503) {
          return "busy";
        }
        if (entries.get(key) === kept) {
          entries.delete(key);
        }
        return "gone";
      },
      () => "busy" as const
    );
    const settled = () => {
      if (refreshes.get(key) === done) {
        refreshes.delete(key);
      }
    };
    done.then(settled, settled);
    refreshes.set(key, done);
    return done;
  }

  /** A stale entry's answer: fresh when its refresh lands within the wait, else the stale entry, so a visitor never waits on it longer; what the address answers now when the refresh dropped it. */
  async function stale(
    request: Request,
    key: string,
    validity: Validity,
    render: (refresh: boolean) => Promise<Response>,
    kept: Entry
  ): Promise<Response> {
    const outcome = await Promise.race([
      refresh(key, validity, render, kept),
      Bun.sleep(staleMs).then(() => "late" as const),
    ]);
    if (outcome === "gone") {
      return await memo.respond(request, key, validity, render);
    }
    return answer(request, typeof outcome === "string" ? kept : outcome);
  }

  const memo: Memo = {
    respond: async (request, key, validity, render) => {
      const kept = entries.get(key);
      if (kept && sameValidity(kept.validity, validity)) {
        entries.delete(key);
        entries.set(key, kept);
        return answer(request, kept);
      }
      if (kept) {
        return await stale(request, key, validity, render, kept);
      }
      const under = rendering.get(key);
      if (under && sameValidity(under.validity, validity)) {
        const rendered = await under.done;
        // A response that may not be stored is one asker's: each other renders their own.
        return rendered instanceof Response
          ? await render(false)
          : answer(request, rendered);
      }
      const done = render(false).then(
        async (response): Promise<Entry | Response> =>
          keeps(response) ? await store(key, validity, response) : response
      );
      rendering.set(key, { done, validity });
      try {
        const rendered = await done;
        return rendered instanceof Response
          ? rendered
          : answer(request, rendered);
      } finally {
        if (rendering.get(key)?.done === done) {
          rendering.delete(key);
        }
      }
    },
    size: () => entries.size,
  };
  return memo;
}
