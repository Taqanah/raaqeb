/**
 * The JSON body of `GET /health`: onboarding, or
 * whether the database answered and the scheduler ticked. No version
 * number. The OpenAPI document reads the same schema.
 */
import { z } from "zod";

export const healthReportSchema = z.union([
  z.object({
    ok: z.literal(true).describe("Always true in onboarding."),
    onboarding: z
      .literal(true)
      .describe("The install is in onboarding: no database is open yet."),
  }),
  z.object({
    database: z
      .enum(["ok", "unreachable"])
      .describe("Whether the database answered one question."),
    ok: z
      .boolean()
      .describe("Whether the database and the scheduler are both ok."),
    scheduler: z
      .enum(["ok", "stale"])
      .describe("Whether the scheduler's last tick is under two minutes old."),
  }),
]);
export type HealthReport = z.infer<typeof healthReportSchema>;
