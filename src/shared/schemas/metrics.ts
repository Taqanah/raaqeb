/**
 * The metrics endpoint's settings page (CONTEXT.md "Metrics endpoint",
 * "Metrics token"): what it shows and what a new token answers with. Each
 * refusal is a code the page words through the catalog (ADR-0004).
 */

/** Where Prometheus reads the install, relative to its address. */
export const metricsPath = "/metrics";

/** What the metrics page shows. */
export interface MetricsView {
  /** The endpoint's full address under the public address, or nothing while none is stored. */
  readonly address: string | undefined;
  /** Whether the endpoint answers: a token is held. */
  readonly on: boolean;
}

/** A fresh token, in clear this once, or why none was made. */
export type MetricsTokenResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: "unavailable" };
