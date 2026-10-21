/**
 * The sidebar's grouped navigation and the command palette's contents: every admin page under its group, the monitors a query
 * finds, and the actions the palette adds. Each page names what it needs,
 * so an operator is offered the pages their role opens (`navigationFor`).
 * Pure, so the palette can be pinned to hold every page. Labels are message
 * ids, worded by the shell.
 */

import { matchesSearch } from "@/shared/domain/monitors.ts";
import type { Permission } from "@/shared/domain/roles.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import type { MonitorChoice } from "@/shared/schemas/monitor.ts";

/** An icon name the shell maps to an inline path. */
export type NavIcon =
  | "monitors"
  | "reports"
  | "pages"
  | "components"
  | "incidents"
  | "maintenance"
  | "channels"
  | "team"
  | "audit"
  | "settings";

export interface NavItem {
  readonly icon: NavIcon;
  readonly id: string;
  readonly label: MessageId;
  /** Where the item leads an operator whose role does not open its page; without one, the item is left out for them. */
  readonly otherwise?: string;
  /** What the page needs (shared/domain/roles.ts). */
  readonly permission: Permission;
  /** The path; a page a later step builds answers the not-found page until then. */
  readonly to: string;
}

export interface NavGroup {
  readonly id: string;
  readonly items: readonly NavItem[];
  readonly label: MessageId;
}

/** Monitoring, then the status pages and what appears on them, then the install itself. */
export const navigation: readonly NavGroup[] = [
  {
    id: "monitoring",
    items: [
      {
        icon: "monitors",
        id: "monitors",
        label: "monitor_list_title",
        permission: "read",
        to: "/admin/monitors",
      },
      {
        icon: "reports",
        id: "reports",
        label: "report_list_title",
        permission: "read",
        to: "/admin/reports",
      },
    ],
    label: "app_nav_monitoring",
  },
  {
    id: "status",
    items: [
      {
        icon: "pages",
        id: "pages",
        label: "page_list_title",
        permission: "read",
        to: "/admin/pages",
      },
      {
        icon: "components",
        id: "components",
        label: "component_list_title",
        permission: "read",
        to: "/admin/components",
      },
      {
        icon: "incidents",
        id: "incidents",
        label: "incident_list_title",
        permission: "read",
        to: "/admin/incidents",
      },
      {
        icon: "maintenance",
        id: "maintenance",
        label: "maintenance_list_title",
        permission: "read",
        to: "/admin/maintenance",
      },
    ],
    label: "app_nav_status",
  },
  {
    id: "install",
    items: [
      {
        icon: "channels",
        id: "channels",
        label: "channel_list_title",
        permission: "read",
        to: "/admin/channels",
      },
      {
        icon: "team",
        id: "team",
        label: "team_title",
        permission: "team",
        to: "/admin/team",
      },
      {
        icon: "audit",
        id: "audit",
        label: "audit_title",
        permission: "audit",
        to: "/admin/audit",
      },
      {
        icon: "settings",
        id: "settings",
        label: "setting_title",
        // Every operator has settings of their own: the account page.
        otherwise: "/admin/settings/account",
        permission: "settings",
        to: "/admin/settings",
      },
    ],
    label: "app_nav_install",
  },
];

/** Pages the palette offers after a group's own, which the sidebar leaves to their area's navigation. */
const paletteOnly: Readonly<Record<string, readonly NavItem[]>> = {
  install: [
    {
      icon: "settings",
      id: "setup_check",
      label: "setting_setup_check",
      permission: "settings",
      to: "/admin/settings/setup-check",
    },
  ],
};

/** The items an operator's role opens, each led to the page it opens for them; a group left empty is left out. */
function itemsFor(
  items: readonly NavItem[],
  allowed: (permission: Permission) => boolean
): NavItem[] {
  return items.flatMap((item) => {
    if (allowed(item.permission)) {
      return [item];
    }
    return item.otherwise === undefined
      ? []
      : [{ ...item, permission: "profile" as const, to: item.otherwise }];
  });
}

/** The navigation an operator is offered: the pages their role opens. */
export function navigationFor(
  allowed: (permission: Permission) => boolean
): readonly NavGroup[] {
  return navigation.flatMap((group) => {
    const items = itemsFor(group.items, allowed);
    return items.length === 0 ? [] : [{ ...group, items }];
  });
}

/** What the palette offers beyond navigation. */
export type PaletteAction = "new_monitor" | "shortcuts" | "sign_out";

export type PaletteItem =
  | { readonly kind: "page"; readonly item: NavItem }
  | {
      readonly kind: "action";
      readonly action: PaletteAction;
      readonly id: string;
      readonly label: MessageId;
    }
  /** A monitor the query finds, opening its detail page. */
  | {
      readonly kind: "monitor";
      readonly id: string;
      readonly monitor: MonitorChoice;
    }
  /** The monitor list searched for the query, which does the full matching. */
  | { readonly kind: "search"; readonly id: string; readonly query: string };

export interface PaletteGroup {
  readonly id: string;
  readonly items: readonly PaletteItem[];
  readonly label: MessageId;
}

/**
 * Every page the operator's role opens, then, once the query has text, the
 * monitors it finds under the list's search rule, by name under the locale,
 * and the list searched for it; then the actions, a new monitor only for a
 * role that makes one.
 */
export function paletteGroups(
  query: string,
  monitors: readonly MonitorChoice[],
  locale: string,
  allowed: (permission: Permission) => boolean = () => true
): readonly PaletteGroup[] {
  const text = query.trim();
  const collator = new Intl.Collator(locale);
  const found: PaletteGroup[] =
    text === ""
      ? []
      : [
          {
            id: "found_monitors",
            items: [
              ...monitors
                .filter((monitor) => matchesSearch(monitor, text, locale))
                .toSorted((a, b) => collator.compare(a.name, b.name))
                .map((monitor) => ({
                  id: `monitor:${monitor.id}`,
                  kind: "monitor" as const,
                  monitor,
                })),
              { id: "search_monitors", kind: "search" as const, query: text },
            ],
            label: "monitor_list_title",
          },
        ];
  const actions: PaletteItem[] = [
    {
      action: "new_monitor",
      id: "new_monitor",
      kind: "action",
      label: "monitor_add",
    },
    {
      action: "shortcuts",
      id: "shortcuts",
      kind: "action",
      label: "app_shortcuts",
    },
    {
      action: "sign_out",
      id: "sign_out",
      kind: "action",
      label: "auth_sign_out",
    },
  ];
  return [
    ...navigation.flatMap((group) => {
      const items = itemsFor(
        [...group.items, ...(paletteOnly[group.id] ?? [])],
        allowed
      );
      return items.length === 0
        ? []
        : [
            {
              id: group.id,
              items: items.map((item) => ({ item, kind: "page" as const })),
              label: group.label,
            },
          ];
    }),
    ...found,
    {
      id: "actions",
      items: actions.filter(
        (item) =>
          !(item.kind === "action" && item.action === "new_monitor") ||
          allowed("monitors")
      ),
      label: "app_nav_actions",
    },
  ];
}
