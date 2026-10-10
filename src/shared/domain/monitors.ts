/**
 * The monitors list's pure rules: what a
 * monitor's target is, and how the list is searched, filtered and sorted.
 * No I/O; the route hands the repository's list and the search parameters in.
 */
import {
  type DatabaseCheckType,
  databasePorts,
  type Monitor,
  type MonitorConfig,
  type MonitorListSearch,
} from "@/shared/schemas/monitor.ts";

/** `host:port`; an IPv6 host is bracketed so the port reads apart from it, unless a URL already did. */
export function addressOf(host: string, port: number): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

/** The URL, `host:port` or name the check reaches, a database monitor's address, a Docker monitor's container; a heartbeat monitor has none. */
export function targetOf(config: MonitorConfig): string | undefined {
  switch (config.type) {
    case "http":
      return config.url;
    case "tcp":
      return addressOf(config.host, config.port);
    case "dns":
      return config.name;
    case "postgres":
    case "mysql":
    case "redis":
      return config.address;
    case "docker":
      return config.container;
    default:
      return;
  }
}

/** What a database monitor's list shows of its connection URL: `host:port`, the check type's port when the URL names none; never the user, the password, the database or the options. */
export function connectionAddress(
  type: DatabaseCheckType,
  url: string
): string {
  const { hostname, port } = new URL(url);
  return `${hostname}:${port || databasePorts[type]}`;
}

/** The list's search rule, which the command palette shares: the query, case-folded, anywhere in the name or the target. */
export function matchesSearch(
  monitor: Pick<Monitor, "name" | "target">,
  query: string,
  locale: string
): boolean {
  const folded = query.toLocaleLowerCase(locale);
  return (
    monitor.name.toLocaleLowerCase(locale).includes(folded) ||
    (monitor.target?.toLocaleLowerCase(locale).includes(folded) ?? false)
  );
}

/**
 * Search matches the name and the target, case-folded, anywhere; a group or
 * a tag filter keeps monitors carrying that exact name; the sort is by name
 * under the locale's collation, or newest first.
 */
export function arrangeMonitors(
  monitors: readonly Monitor[],
  search: MonitorListSearch,
  locale: string
): Monitor[] {
  const { q } = search;
  const kept = monitors.filter(
    (monitor) =>
      (search.group === undefined || monitor.group === search.group) &&
      (search.tag === undefined || monitor.tags.includes(search.tag)) &&
      (q === undefined || matchesSearch(monitor, q, locale))
  );
  if (search.sort === "newest") {
    return kept.toSorted((a, b) => b.createdAt - a.createdAt);
  }
  const collator = new Intl.Collator(locale);
  return kept.toSorted((a, b) => collator.compare(a.name, b.name));
}

/** The group and tag names the filters offer: every one a listed monitor carries, sorted under the locale. */
export function filterOptions(
  monitors: readonly Monitor[],
  locale: string
): { groups: string[]; tags: string[] } {
  const collator = new Intl.Collator(locale);
  const groups = new Set<string>();
  const tags = new Set<string>();
  for (const monitor of monitors) {
    if (monitor.group !== undefined) {
      groups.add(monitor.group);
    }
    for (const tag of monitor.tags) {
      tags.add(tag);
    }
  }
  return {
    groups: [...groups].sort(collator.compare),
    tags: [...tags].sort(collator.compare),
  };
}
