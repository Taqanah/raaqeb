/**
 * The signed-in operator behind a request (CONTEXT.md "Operator"): read on the
 * server from the session cookie through `auth.api.getSession`, which also
 * refreshes a session past its update age. The operator middleware
 * (src/routes/-admin.ts) is its one caller; the preview of an unpublished
 * page reads the session through `isOperator`, which refreshes nothing.
 */
import type { Storage } from "@/server/storage/storage.ts";
import { type Auth, type AuthBoot, authFor } from "./auth.ts";

export interface Operator {
  readonly email: string;
  readonly id: string;
}

export interface OperatorSession {
  readonly operator: Operator;
  /** The `set-cookie` value Better Auth issued when it refreshed the session; the caller puts it on the response so the browser's cookie lives on with the row. */
  readonly setCookie: string | undefined;
}

/** A signed-in operator with what the session was read through: the open storage and its Better Auth instance, which every handler behind the guard reuses. */
export interface OperatorContext extends OperatorSession {
  readonly auth: Auth;
  readonly storage: Storage;
}

/** The operator whose session the request's cookies name, or nothing. */
export async function readOperator(
  auth: Auth,
  headers: Headers
): Promise<OperatorSession | undefined> {
  // A database that cannot answer is no session; the guard sends the request to sign-in rather than an error page.
  const read = await auth.api
    .getSession({ headers, returnHeaders: true })
    .catch(() => undefined);
  const session = read?.response;
  if (!session) {
    return;
  }
  return {
    operator: { email: session.user.email, id: session.user.id },
    setCookie: read.headers.get("set-cookie") ?? undefined,
  };
}

/** Each request's session read. Held here, in one shared chunk: each route chunk carries its own copy of a route module like -admin.ts. */
const reads = new WeakMap<Request, Promise<OperatorContext | undefined>>();

/** `operatorFor` once a request: a server render calls the guard, the shell and the page's server functions inside one request. */
export function operatorOfRequest(
  storage: Storage | undefined,
  boot: AuthBoot,
  request: Request
): Promise<OperatorContext | undefined> {
  let read = reads.get(request);
  if (!read) {
    read = operatorFor(storage, boot, new Headers(request.headers));
    reads.set(request, read);
  }
  return read;
}

/**
 * The operator behind a request context, with the storage and the instance
 * the session was read through: nothing with no database, nothing when the
 * database cannot answer, so the guard's server function never throws.
 */
export async function operatorFor(
  storage: Storage | undefined,
  boot: AuthBoot,
  headers: Headers
): Promise<OperatorContext | undefined> {
  if (!storage) {
    return;
  }
  let auth: Auth;
  try {
    auth = await authFor(storage, boot);
  } catch {
    return;
  }
  const session = await readOperator(auth, headers);
  return session && { ...session, auth, storage };
}

/**
 * Whether the request carries the operator's session, read without
 * refreshing it (`disableRefresh`, Better Auth 1.7's getSession), so the
 * row's expiry never moves past a cookie the response does not re-issue:
 * for the preview of an unpublished page and its images, which set
 * no cookie. False with no database, or when it cannot answer.
 */
export async function isOperator(
  storage: Storage | undefined,
  boot: AuthBoot,
  headers: Headers
): Promise<boolean> {
  if (!storage) {
    return false;
  }
  try {
    const auth = await authFor(storage, boot);
    const session = await auth.api.getSession({
      headers,
      query: { disableRefresh: true },
    });
    return session !== null;
  } catch {
    // A database that cannot answer is no session, as for the guard.
    return false;
  }
}
