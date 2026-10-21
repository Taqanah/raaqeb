/**
 * The management API's rate limit: each API key holds a bucket of calls
 * that refills at a steady pace, so a burst passes and a flood waits. Held
 * in memory per process, as Better Auth's sign-in limit is; one entry per
 * key that called, so it is bounded by the keys the install has. No I/O:
 * `now` is a parameter.
 */

/** How many calls a key may make at once, and how many a second it gets back. */
export interface RateLimits {
  readonly burst: number;
  readonly perSecond: number;
}

/** The limit the API holds every key to: a burst of 120 calls, then one a second. */
export const apiRateLimits: RateLimits = { burst: 120, perSecond: 1 };

export interface RateLimit {
  /** Spends one call of the key's bucket: nothing when it had one, else the whole seconds until it will. */
  readonly take: (key: string, now: number) => number | undefined;
}

export function createRateLimit(limits: RateLimits): RateLimit {
  // Each key's calls left and when they were counted; a key that never called holds the whole burst.
  const buckets = new Map<string, { left: number; at: number }>();
  return {
    take: (key, now) => {
      const held = buckets.get(key);
      const left = held
        ? Math.min(
            limits.burst,
            held.left + ((now - held.at) / 1000) * limits.perSecond
          )
        : limits.burst;
      if (left < 1) {
        buckets.set(key, { at: now, left });
        return Math.ceil((1 - left) / limits.perSecond);
      }
      buckets.set(key, { at: now, left: left - 1 });
    },
  };
}
