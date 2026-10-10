import { describe, expect, test } from "bun:test";
import { observedMaxLength } from "@/shared/schemas/reason.ts";
import {
  evaluateAssertions,
  type ObservedResponse,
  statusInSet,
} from "./assertions.ts";
import { credentialMask, credentialPatterns } from "./capture.ts";

const encoder = new TextEncoder();

function response(
  overrides: Partial<ObservedResponse> & { text?: string } = {}
): ObservedResponse {
  const { text, ...rest } = overrides;
  return {
    body: encoder.encode(
      text ?? '{"status":"healthy","count":3,"nested":{"ok":true}}'
    ),
    headers: new Headers({
      "content-type": "application/json",
      "x-env": "prod",
    }),
    responseMs: 120,
    statusCode: 200,
    ...rest,
  };
}

describe("a status set", () => {
  test("a class, a code and a range each match what they name", () => {
    expect(statusInSet(["2xx"], 204)).toBe(true);
    expect(statusInSet(["2xx"], 301)).toBe(false);
    expect(statusInSet(["204"], 204)).toBe(true);
    expect(statusInSet(["204"], 200)).toBe(false);
    expect(statusInSet(["200-299"], 299)).toBe(true);
    expect(statusInSet(["200-299"], 300)).toBe(false);
    expect(statusInSet(["301", "4xx"], 404)).toBe(true);
  });
});

describe("the success rules", () => {
  test("an empty body with a passing status is up", () => {
    expect(
      evaluateAssertions(
        [{ codes: ["2xx"], kind: "status" }],
        response({ text: "" })
      )
    ).toEqual({ ok: true });
  });

  test("a status outside the set is the reason unexpected status, with the set and the code", () => {
    expect(
      evaluateAssertions(
        [{ codes: ["2xx", "304"], kind: "status" }],
        response({ statusCode: 503 })
      )
    ).toEqual({
      assertion: { codes: ["2xx", "304"], kind: "status" },
      ok: false,
      params: {
        expected: ["2xx", "304"],
        observed: 503,
        reason: "unexpected_status",
      },
      reason: "unexpected_status",
    });
  });

  test("body contains and does not contain read the body as text", () => {
    expect(
      evaluateAssertions(
        [{ kind: "body_contains", text: "healthy" }],
        response()
      )
    ).toEqual({ ok: true });
    expect(
      evaluateAssertions(
        [{ kind: "body_not_contains", text: "error" }],
        response()
      )
    ).toEqual({ ok: true });
    expect(
      evaluateAssertions([{ kind: "body_contains", text: "error" }], response())
    ).toEqual({
      assertion: { kind: "body_contains", text: "error" },
      ok: false,
      params: {
        expected: "error",
        observed: '{"status":"healthy","count":3,"nested":{"ok":true}}',
        reason: "assertion_failed",
      },
      reason: "assertion_failed",
    });
    expect(
      evaluateAssertions(
        [{ kind: "body_not_contains", text: "healthy" }],
        response()
      )
    ).toMatchObject({
      ok: false,
      params: { expected: "healthy", reason: "assertion_failed" },
      reason: "assertion_failed",
    });
  });

  test("JSON equals compares the value at the path as text", () => {
    expect(
      evaluateAssertions(
        [{ kind: "json_equals", path: "status", value: "healthy" }],
        response()
      )
    ).toEqual({ ok: true });
    expect(
      evaluateAssertions(
        [{ kind: "json_equals", path: "count", value: "3" }],
        response()
      )
    ).toEqual({ ok: true });
    expect(
      evaluateAssertions(
        [{ kind: "json_equals", path: "nested.ok", value: "true" }],
        response()
      )
    ).toEqual({ ok: true });
    expect(
      evaluateAssertions(
        [{ kind: "json_equals", path: "status", value: "down" }],
        response()
      )
    ).toEqual({
      assertion: { kind: "json_equals", path: "status", value: "down" },
      ok: false,
      params: {
        expected: "down",
        observed: "healthy",
        reason: "assertion_failed",
      },
      reason: "assertion_failed",
    });
  });

  test("JSON matches runs the pattern over the value's text", () => {
    expect(
      evaluateAssertions(
        [{ kind: "json_matches", path: "status", pattern: "^heal" }],
        response()
      )
    ).toEqual({ ok: true });
    expect(
      evaluateAssertions(
        [{ kind: "json_matches", path: "count", pattern: "^[0-9]+$" }],
        response()
      )
    ).toEqual({ ok: true });
    expect(
      evaluateAssertions(
        [{ kind: "json_matches", path: "status", pattern: "^down" }],
        response()
      )
    ).toMatchObject({
      ok: false,
      params: {
        expected: "^down",
        observed: "healthy",
        reason: "assertion_failed",
      },
    });
  });

  test("a missing path or a body that is not JSON never satisfies a JSON assertion, whatever it expects, and fails with what was seen", () => {
    // An empty expected value must not equal "nothing found".
    expect(
      evaluateAssertions(
        [{ kind: "json_equals", path: "missing", value: "" }],
        response()
      )
    ).toMatchObject({
      ok: false,
      params: { expected: "", observed: "", reason: "assertion_failed" },
    });
    // A pattern that matches the empty string must not pass on a missing path.
    expect(
      evaluateAssertions(
        [{ kind: "json_matches", path: "missing", pattern: "[a-z]*" }],
        response()
      )
    ).toMatchObject({
      ok: false,
      params: { expected: "[a-z]*", observed: "", reason: "assertion_failed" },
    });
    // A pattern found in an HTML error page must not pass as if it were the field.
    expect(
      evaluateAssertions(
        [{ kind: "json_matches", path: "status", pattern: "ok" }],
        response({ text: "<html>service ok</html>" })
      )
    ).toMatchObject({
      ok: false,
      params: {
        expected: "ok",
        observed: "<html>service ok</html>",
        reason: "assertion_failed",
      },
    });
    expect(
      evaluateAssertions(
        [{ kind: "json_equals", path: "status", value: "<html>" }],
        response({ text: "<html>" })
      )
    ).toMatchObject({
      ok: false,
      params: {
        expected: "<html>",
        observed: "<html>",
        reason: "assertion_failed",
      },
    });
  });

  test("an invalid pattern fails the assertion rather than the process", () => {
    expect(
      evaluateAssertions(
        [{ kind: "json_matches", path: "status", pattern: "(" }],
        response()
      )
    ).toMatchObject({
      ok: false,
      params: {
        expected: "(",
        observed: "healthy",
        reason: "assertion_failed",
      },
    });
  });

  test("header equals matches the name without case and the value exactly", () => {
    expect(
      evaluateAssertions(
        [{ kind: "header_equals", name: "X-Env", value: "prod" }],
        response()
      )
    ).toEqual({ ok: true });
    expect(
      evaluateAssertions(
        [{ kind: "header_equals", name: "x-env", value: "Prod" }],
        response()
      )
    ).toMatchObject({
      ok: false,
      params: {
        expected: "Prod",
        observed: "prod",
        reason: "assertion_failed",
      },
    });
    expect(
      evaluateAssertions(
        [{ kind: "header_equals", name: "x-missing", value: "" }],
        response()
      )
    ).toMatchObject({
      ok: false,
      params: { expected: "", observed: "", reason: "assertion_failed" },
    });
  });

  test("response time under N is a hard assertion and the reason slow", () => {
    expect(
      evaluateAssertions(
        [{ kind: "response_time_under", ms: 500 }],
        response({ responseMs: 120 })
      )
    ).toEqual({ ok: true });
    expect(
      evaluateAssertions(
        [{ kind: "response_time_under", ms: 100 }],
        response({ responseMs: 120 })
      )
    ).toEqual({
      assertion: { kind: "response_time_under", ms: 100 },
      ok: false,
      params: { limitMs: 100, observedMs: 120, reason: "slow" },
      reason: "slow",
    });
    expect(
      evaluateAssertions(
        [{ kind: "response_time_under", ms: 120 }],
        response({ responseMs: 120 })
      )
    ).toMatchObject({ ok: false });
  });

  test("assertions run in order and the first failure is the verdict", () => {
    const verdict = evaluateAssertions(
      [
        { codes: ["2xx"], kind: "status" },
        { kind: "body_contains", text: "missing" },
        { kind: "response_time_under", ms: 1 },
      ],
      response()
    );
    expect(verdict).toMatchObject({ ok: false, reason: "assertion_failed" });
  });

  test("an observed value is cut to 200 characters", () => {
    const verdict = evaluateAssertions(
      [{ kind: "body_contains", text: "needle" }],
      response({ text: "x".repeat(1000) })
    );
    expect(verdict).toMatchObject({
      params: { observed: "x".repeat(observedMaxLength) },
    });
  });

  test("an expected value longer than 200 characters is cut the same way in the parameters", () => {
    const verdict = evaluateAssertions(
      [{ kind: "body_contains", text: "y".repeat(300) }],
      response({ text: "short" })
    );
    expect(verdict).toMatchObject({
      assertion: { text: "y".repeat(300) },
      params: { expected: "y".repeat(observedMaxLength), observed: "short" },
    });
  });

  test("a body that is not UTF-8 still reads as text for the assertions", () => {
    expect(
      evaluateAssertions(
        [{ kind: "body_contains", text: "ok" }],
        response({ body: new Uint8Array([0xff, 0xfe, 0x6f, 0x6b]) })
      )
    ).toEqual({ ok: true });
  });
});

describe("a credential the response repeats", () => {
  const sent = () => credentialPatterns(["tok-secret"]);

  test("the success rules judge the response as it came, and the text they quote masks the credential", () => {
    expect(
      evaluateAssertions(
        [{ kind: "body_contains", text: "tok-secret" }],
        response({ text: '{"token":"tok-secret"}' }),
        sent()
      )
    ).toEqual({ ok: true });
    expect(
      evaluateAssertions(
        [{ kind: "body_not_contains", text: "tok-secret" }],
        response({ text: '{"token":"tok-secret"}' }),
        sent()
      )
    ).toMatchObject({
      params: {
        expected: credentialMask,
        observed: `{"token":"${credentialMask}"}`,
      },
    });
  });

  test("is masked in an observed header value and an observed JSON value", () => {
    expect(
      evaluateAssertions(
        [{ kind: "header_equals", name: "x-echo", value: "other" }],
        response({ headers: new Headers({ "x-echo": "Bearer tok-secret" }) }),
        sent()
      )
    ).toMatchObject({ params: { observed: `Bearer ${credentialMask}` } });
    expect(
      evaluateAssertions(
        [{ kind: "json_equals", path: "token", value: "other" }],
        response({ text: '{"token":"tok-secret"}' }),
        sent()
      )
    ).toMatchObject({ params: { observed: credentialMask } });
  });

  test("straddling the 200-character cut leaves no part of itself in the observed value", () => {
    const before = "x".repeat(observedMaxLength - 4);
    expect(
      evaluateAssertions(
        [{ kind: "body_contains", text: "needle" }],
        response({ text: `${before}tok-secret` }),
        sent()
      )
    ).toMatchObject({
      params: { observed: `${before}${credentialMask.slice(0, 4)}` },
    });
  });
});
