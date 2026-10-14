/**
 * The words the status page screens share: a save's refusal, by its
 * reason, and an image upload's.
 */
import type { MessageId } from "@/shared/i18n/messages.ts";
import type { PageImageRefusal, PageRefusal } from "@/shared/schemas/page.ts";

export const pageRefusalWords: Readonly<Record<PageRefusal, MessageId>> = {
  domain_public_address: "page_refused_domain_public",
  domain_taken: "page_refused_domain_taken",
  invalid: "app_form_invalid",
  not_found: "page_not_found",
  slug_taken: "page_refused_slug_taken",
  // A write that failed says nothing changed; "could not be read" is a read's line.
  unavailable: "app_write_unavailable",
};

export const imageRefusalWords: Readonly<Record<PageImageRefusal, MessageId>> =
  {
    invalid: "page_image_invalid",
    not_found: "page_not_found",
    too_large: "page_image_too_large",
    unavailable: "page_image_unavailable",
  };
