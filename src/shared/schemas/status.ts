/**
 * The status level (CONTEXT.md "Status level"): one of five
 * fixed states of a component or a page. The machine values are
 * Statuspage's and never change; a page may rename the labels for display
 * only. Listed in the order worst wins, so a page's level is the one
 * furthest along this list among its components'.
 */
import { z } from "zod";

export const statusLevels = [
  "operational",
  "under_maintenance",
  "degraded_performance",
  "partial_outage",
  "major_outage",
] as const;
export const statusLevelSchema = z.enum(statusLevels);
export type StatusLevel = z.infer<typeof statusLevelSchema>;

/** What an operator sets on a component by hand: every level but under maintenance, which only a maintenance window sets. */
export const handSetLevels = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
] as const;
export const handSetLevelSchema = z.enum(handSetLevels);
export type HandSetLevel = z.infer<typeof handSetLevelSchema>;
