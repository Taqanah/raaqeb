/**
 * How the management API answers (CONTEXT.md "Management API"): which
 * operation a method and a path name, a refusal's status and JSON body by
 * its reason (ADR-0004), and one page of a list. No I/O.
 */

import {
  type ManagementOperationName,
  managementOperations,
} from "@/shared/api/management.ts";
import type { ApiError, PageQuery } from "@/shared/api/records.ts";

/** The operation a request names, with its path's parameters; or why none. */
export type OperationMatch =
  | {
      readonly name: ManagementOperationName;
      readonly ok: true;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly reason: "not_found" }
  /** The path is an operation's, the method is not: `allow` names the methods it takes. */
  | {
      readonly allow: readonly string[];
      readonly ok: false;
      readonly reason: "method_not_allowed";
    };

/** One operation's path as segments to match: a fixed word, or a parameter's name. */
interface Shape {
  /** How many of its segments are fixed words: a path both a word and a parameter fit is the word's. */
  readonly fixed: number;
  readonly method: string;
  readonly name: ManagementOperationName;
  readonly segments: readonly {
    readonly param?: string;
    readonly word?: string;
  }[];
}

const templateParameter = /^\{(\w+)\}$/;

function isOperationName(name: string): name is ManagementOperationName {
  return Object.hasOwn(managementOperations, name);
}

const shapes: readonly Shape[] = Object.entries(managementOperations).flatMap(
  ([name, operation]) => {
    if (!isOperationName(name)) {
      return [];
    }
    const segments = operation.path
      .split("/")
      .slice(1)
      .map((segment) => {
        const param = templateParameter.exec(segment)?.[1];
        return param === undefined ? { word: segment } : { param };
      });
    return [
      {
        fixed: segments.filter((segment) => segment.word !== undefined).length,
        method: operation.method.toUpperCase(),
        name,
        segments,
      },
    ];
  }
);

/** The parameters a path fits the shape with, decoded; nothing when it does not fit. */
function fit(
  shape: Shape,
  parts: readonly string[]
): Record<string, string> | undefined {
  if (parts.length !== shape.segments.length) {
    return;
  }
  const params: Record<string, string> = {};
  for (const [index, segment] of shape.segments.entries()) {
    const part = parts[index] ?? "";
    if (segment.word !== undefined) {
      if (part.toLowerCase() !== segment.word) {
        return;
      }
    } else if (segment.param !== undefined) {
      if (part === "") {
        return;
      }
      try {
        params[segment.param] = decodeURIComponent(part);
      } catch {
        return;
      }
    }
  }
  return params;
}

interface Fitting {
  readonly params: Record<string, string>;
  readonly shape: Shape;
}

/** The operation at the method and path, matched as the router matches a path: whatever its case, with or without a trailing slash. */
export function matchOperation(
  method: string,
  pathname: string
): OperationMatch {
  const trimmed =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  const parts = trimmed.split("/").slice(1);
  const fitting: Fitting[] = shapes.flatMap((shape) => {
    const params = fit(shape, parts);
    return params ? [{ params, shape }] : [];
  });
  const [best] = fitting
    .filter((each) => each.shape.method === method.toUpperCase())
    .toSorted((a, b) => b.shape.fixed - a.shape.fixed);
  if (best) {
    return { name: best.shape.name, ok: true, params: best.params };
  }
  if (fitting.length === 0) {
    return { ok: false, reason: "not_found" };
  }
  return {
    allow: [...new Set(fitting.map((each) => each.shape.method))].toSorted(),
    ok: false,
    reason: "method_not_allowed",
  };
}

/** The statuses of the refusals every operation may meet; any other reason refuses what a record's state allows, a conflict. */
const statuses: Readonly<Record<string, number>> = {
  corrupt: 500,
  forbidden: 403,
  invalid: 422,
  malformed: 400,
  method_not_allowed: 405,
  not_allowed: 403,
  not_found: 404,
  rate_limited: 429,
  second_step: 403,
  unauthenticated: 401,
  unavailable: 503,
};

/** The status a refusal answers with, by its reason. */
export function statusOf(reason: string): number {
  return statuses[reason] ?? 409;
}

/** A refusal as the API answers it: its status, the JSON body, never cached; a missing key's names the Bearer scheme, a spent limit when to try again. */
export function refusal(
  error: ApiError,
  headers: Readonly<Record<string, string>> = {}
): Response {
  return Response.json(error, {
    headers: {
      "cache-control": "no-store",
      ...(error.reason === "unauthenticated"
        ? { "www-authenticate": "Bearer" }
        : {}),
      ...headers,
    },
    status: statusOf(error.reason),
  });
}

/** One page of a list, as the query asks for it. */
export function pageOfList<T>(
  items: readonly T[],
  query: PageQuery
): {
  readonly items: readonly T[];
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
} {
  // ponytail: the list is read whole and sliced here; an install's lists are hundreds of records, a cursor in storage would page more.
  return {
    items: items.slice(query.offset, query.offset + query.limit),
    limit: query.limit,
    offset: query.offset,
    total: items.length,
  };
}
