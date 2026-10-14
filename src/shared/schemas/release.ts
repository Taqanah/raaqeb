/**
 * A published release as the release check keeps it and the admin banner
 * shows it.
 */
import { z } from "zod";

export const releaseSchema = z.object({
  /** The release notes page, over https alone: the banner links to it. */
  url: z.url({ protocol: /^https$/ }),
  /** The tag, with any leading `v` removed. */
  version: z.string(),
});

export type Release = z.infer<typeof releaseSchema>;
