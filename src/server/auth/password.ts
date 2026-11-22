/**
 * Password hashing for the operator account: Argon2id through
 * `Bun.password`, in place of Better Auth's scrypt default. The parameters
 * travel inside the PHC string, so raising them later locks nobody out.
 * `Bun.password.verify` throws on a hash it cannot parse; here that is a
 * failed sign-in, never a 500.
 */

/**
 * OWASP's third listed Argon2id configuration: 12 MiB and 3 iterations. The
 * five listed settings give the same defence and trade CPU for RAM; this one
 * keeps RAM low on the 240 MB floor.
 */
export const argon2id = {
  algorithm: "argon2id",
  memoryCost: 12_288,
  timeCost: 3,
} as const;

// Each hash holds its memory cost while it runs, and Bun runs as many at once as it sees cores, so a burst of sign-ins could pass the floor.
let turn: Promise<unknown> = Promise.resolve();

/** Runs `work` after every hash already asked for has settled. */
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const mine = turn.then(work);
  turn = mine.catch(() => undefined);
  return mine;
}

/** Hashes an NFKC-normalised password into a PHC string. */
export function hashPassword(password: string): Promise<string> {
  return oneAtATime(() =>
    Bun.password.hash(password.normalize("NFKC"), argon2id)
  );
}

/** True when the password matches the hash; false for a wrong password or a hash Bun cannot parse. */
export async function verifyPassword(input: {
  hash: string;
  password: string;
}): Promise<boolean> {
  try {
    return await oneAtATime(() =>
      Bun.password.verify(input.password.normalize("NFKC"), input.hash)
    );
  } catch {
    // A stored value Bun cannot parse, such as a scrypt hash from another hasher, is a failed sign-in.
    return false;
  }
}
