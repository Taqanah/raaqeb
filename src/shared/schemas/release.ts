/**
 * A published release as the release check keeps it and the admin banner
 * shows it.
 */
import { z } from "zod";

export const releaseSchema = z.object({
  /** The release notes page. */
  url: z.url(),
  /** The tag, with any leading `v` removed. */
  version: z.string(),
});

export type Release = z.infer<typeof releaseSchema>;
