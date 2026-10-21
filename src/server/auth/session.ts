/**
 * The signed-in operator behind a request (CONTEXT.md "Operator"): read on the
 * server from the session cookie through `auth.api.getSession`, which also
 * refreshes a session past its update age. The operator middleware
 * (src/routes/-admin.ts) is its one caller; the preview of an unpublished
 * page reads the session through `isOperator`, which refreshes nothing.
 */
import { answerLimitMs, withinLimit } from "@/server/storage/deadline.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { allows, type Permission, type Role } from "@/shared/domain/roles.ts";
import { localeSchema } from "@/shared/i18n/locale.ts";
import {
  calendarSchema,
  clockSchema,
  timeZoneSchema,
} from "@/shared/schemas/clock.ts";
import type { AccountSettingsInput } from "@/shared/schemas/settings.ts";
import { roleSchema } from "@/shared/schemas/team.ts";
import { type Auth, type AuthBoot, authFor } from "./auth.ts";
import { readSecondStepRequired } from "./second-step.ts";

/** Whether the request names a session cookie at all; whether it is a live session is `isOperator`'s to read. */
export function carriesSession(headers: Headers): boolean {
  return sessionCookie.test(headers.get("cookie") ?? "");
}

/** Better Auth's session cookie under Raaqeb's prefix (auth.ts), plain or under the secure prefix it takes over https. */
const sessionCookie = /(^|;\s*)(__Secure-)?raaqeb\.session_token=/;

/** The signed-in operator: their account as the session read it, with the session's own id; or as an API key's call names it, with the key. */
export interface Operator {
  /** The API key the call came with; nothing for a session's. */
  readonly apiKey?: { readonly id: string; readonly name: string };
  readonly email: string;
  readonly id: string;
  /** Empty when the operator gave none. */
  readonly name: string;
  readonly preferences: AccountSettingsInput;
  readonly role: Role;
  /** The second step is on for the account. */
  readonly secondStep: boolean;
  /** Nothing for an API key's call, which has no session. */
  readonly sessionId: string | undefined;
  /** How the session signed in: with the password, or through the identity provider, whose own checks stand for a second step; an API key's call is the password's. */
  readonly signedInWith: "password" | "oidc";
}

/**
 * Why the operator may not do what the permission names: their role does
 * not allow it, or the owner requires a second step they have not switched
 * on, which leaves them their own account alone.
 */
export type Refusal = "role" | "second_step";

/** Nothing when the operator may do what the permission names, else why not. Throws when the database cannot answer. */
export async function refusalOf(
  storage: Pick<Storage, "settings">,
  operator: Operator,
  permission: Permission
): Promise<Refusal | undefined> {
  // An API key's call reaches less than its role: never the account, the settings, the team, nor ownership.
  if (!allows(operator, permission)) {
    return "role";
  }
  // The setting is read only for an operator it could stop: their own account is always theirs, and the identity provider holds the second step of a sign-in through it.
  if (
    permission === "profile" ||
    operator.secondStep ||
    operator.signedInWith === "oidc" ||
    !(await readSecondStepRequired(storage))
  ) {
    return;
  }
  return "second_step";
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
  headers: Headers,
  answerMs: number = answerLimitMs
): Promise<OperatorSession | undefined> {
  // A database that cannot answer is no session; the guard sends the request to sign-in rather than an error page.
  const read = await withinLimit(
    auth.api.getSession({ headers, returnHeaders: true }),
    answerMs
  ).catch(() => undefined);
  const session = read?.response;
  // A deactivated account has no session left; one that outlived it by a race is none either.
  if (!session || session.user.deactivatedAt) {
    return;
  }
  return {
    operator: operatorOf(session.user, session.session),
    setCookie: read.headers.get("set-cookie") ?? undefined,
  };
}

/** The operator a session's user row names, its role and preferences parsed as storage parses them. */
function operatorOf(
  user: {
    readonly calendar?: string | null;
    readonly clock?: string | null;
    readonly email: string;
    readonly id: string;
    readonly language?: string | null;
    readonly name: string;
    readonly role: string;
    readonly timeZone?: string | null;
    readonly twoFactorEnabled?: boolean | null;
  },
  session: { readonly id: string; readonly method?: string | null }
): Operator {
  const preferences: AccountSettingsInput = Object.fromEntries(
    Object.entries({
      calendar: calendarSchema.safeParse(user.calendar).data,
      clock: clockSchema.safeParse(user.clock).data,
      operatorLanguage: localeSchema.safeParse(user.language).data,
      timeZone: timeZoneSchema.safeParse(user.timeZone).data,
    }).filter(([, value]) => value !== undefined)
  );
  return {
    email: user.email,
    id: user.id,
    name: user.name,
    preferences,
    // A role the code no longer names is the least one, never more.
    role: roleSchema.catch("viewer").parse(user.role),
    secondStep: user.twoFactorEnabled === true,
    sessionId: session.id,
    signedInWith: session.method === "oidc" ? "oidc" : "password",
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
 * for the entry's pace, which a signed-in operator skips, and for the
 * preview of an unpublished page and its images, which set no cookie. With
 * a `permission`, as for a preview, also whether the operator holds it now,
 * a required second step included, as every admin page asks. False for a
 * deactivated account, with no database, or when it cannot answer.
 */
export async function isOperator(
  storage: Storage | undefined,
  boot: AuthBoot,
  headers: Headers,
  answerMs: number = answerLimitMs,
  permission?: Permission
): Promise<boolean> {
  if (!storage) {
    return false;
  }
  try {
    const auth = await authFor(storage, boot);
    const session = await withinLimit(
      auth.api.getSession({ headers, query: { disableRefresh: true } }),
      answerMs
    );
    if (!session || session.user.deactivatedAt) {
      return false;
    }
    if (permission === undefined) {
      return true;
    }
    const operator = operatorOf(session.user, session.session);
    return (await refusalOf(storage, operator, permission)) === undefined;
  } catch {
    // A database that cannot answer is no session, as for the guard.
    return false;
  }
}
