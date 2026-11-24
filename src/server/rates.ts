/**
 * The rate rules' buckets (CONTEXT.md "Rate rule"): one token bucket per rule
 * and client, in memory, on one process. A bucket that has filled again is
 * the same as no bucket, so the table holds only clients that asked lately:
 * a newcomer sweeps it, at most once a second, and one that still
 * finds it full counts in one bucket shared by every newcomer of its rule, so
 * a flood of new addresses neither grows the table nor resets a known client.
 */

/** How many a client may send at once, and how often one more comes back. */
export interface Rate {
  readonly capacity: number;
  readonly everyMs: number;
}

/** The buckets: `take` spends one token from the client's bucket of a rule, `waits` only looks at the bucket `take` would spend from; each answers 0 when there is a token, else the whole seconds until the next is due. */
export interface Rates {
  /** How many clients' buckets the table holds, besides the shared ones. */
  readonly size: () => number;
  readonly take: (rule: string, rate: Rate, client: string) => number;
  readonly waits: (rule: string, rate: Rate, client: string) => number;
}

interface Bucket {
  at: number;
  readonly rate: Rate;
  tokens: number;
}

const sweepEveryMs = 1000;

/** The buckets, at most `cap` clients' on a clock that `now` reads in milliseconds. */
export function createRates(
  cap: number,
  now: () => number = performance.now.bind(performance)
): Rates {
  const held = new Map<string, Bucket>();
  const shared = new Map<string, Bucket>();
  let sweptAt = now();
  const level = (bucket: Bucket, at: number) =>
    Math.min(
      bucket.rate.capacity,
      bucket.tokens + (at - bucket.at) / bucket.rate.everyMs
    );
  const sweep = (at: number) => {
    sweptAt = at;
    for (const [key, bucket] of held) {
      if (level(bucket, at) >= bucket.rate.capacity) {
        held.delete(key);
      }
    }
  };
  const due = (bucket: Bucket, rate: Rate) =>
    Math.ceil(((1 - bucket.tokens) * rate.everyMs) / 1000);
  /** Where a client's bucket of a rule is: its own, else past the cap the rule's shared one; a newcomer sweeps first, at most once a second. */
  const find = (rule: string, client: string, at: number) => {
    const key = `${rule} ${client}`;
    if (!held.has(key) && at - sweptAt >= sweepEveryMs) {
      sweep(at);
    }
    return held.has(key) || held.size < cap
      ? { name: key, table: held }
      : { name: rule, table: shared };
  };
  return {
    size: () => held.size,
    take: (rule, rate, client) => {
      const at = now();
      const { name, table } = find(rule, client, at);
      const bucket = table.get(name) ?? { at, rate, tokens: rate.capacity };
      bucket.tokens = level(bucket, at);
      bucket.at = at;
      table.set(name, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return 0;
      }
      return due(bucket, rate);
    },
    waits: (rule, rate, client) => {
      const at = now();
      const { name, table } = find(rule, client, at);
      const bucket = table.get(name);
      if (!bucket) {
        return 0;
      }
      const tokens = level(bucket, at);
      return tokens >= 1 ? 0 : due({ ...bucket, tokens }, rate);
    },
  };
}
