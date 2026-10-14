/**
 * The longest a request waits on the database: a database that never answers
 * (a paused server, a dropped route) leaves a query pending for good, and the
 * page, `/health` and the scheduler's counter read behind it with it. A wait
 * past the bound fails like any other read the database could not serve.
 */

/** How long a statement, or a session read, may take before it counts as not answered; two of them fit in Bun's ten idle seconds, so a page whose first reads fail still answers. */
export const answerLimitMs = 4000;

/** The wait ran out: the database said nothing within the limit. */
export class NoAnswerError extends Error {
  constructor(limitMs: number) {
    super(`the database did not answer within ${limitMs} ms`);
    this.name = "NoAnswerError";
  }
}

/** Whether `work` settled with its own answer or error within `limitMs`; the error of a wait that ran out names the limit. */
export async function withinLimit<T>(
  work: PromiseLike<T>,
  limitMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NoAnswerError(limitMs)), limitMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
