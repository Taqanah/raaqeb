/**
 * What changing a page's record needs, by its path (shared/domain/roles.ts):
 * the shell reads it to show a page whose role reads it but cannot change it
 * read-only, its fields and buttons disabled with the reason. A page whose
 * read alone needs more is refused by its loader instead.
 */
import type { Permission } from "@/shared/domain/roles.ts";

const forms: readonly [RegExp, Permission][] = [
  [/^\/admin\/monitors\/(new|[^/]+\/edit)\/?$/, "monitors"],
  [/^\/admin\/(pages|components)\/[^/]+\/?$/, "pages"],
  [/^\/admin\/incidents\/[^/]+\/?$/, "incidents"],
  [/^\/admin\/maintenance\/(series\/)?[^/]+\/?$/, "maintenance"],
  [/^\/admin\/channels\/[^/]+\/?$/, "channels"],
];

/** The permission changing the page's record needs; nothing for a page that changes no record of its own, or whose actions each say theirs. */
export function formPermissionOf(pathname: string): Permission | undefined {
  return forms.find(([path]) => path.test(pathname))?.[1];
}
