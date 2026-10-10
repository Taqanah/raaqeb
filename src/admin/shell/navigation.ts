/**
 * The sidebar's grouped navigation and the command palette's contents: every admin page under its group, the monitors a query
 * finds, and the actions the palette adds. Pure, so the palette can be
 * pinned to hold every page. Labels are message ids, worded by the shell.
 */
import { matchesSearch } from "@/shared/domain/monitors.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import type { MonitorChoice } from "@/shared/schemas/monitor.ts";

/** An icon name the shell maps to an inline path. */
export type NavIcon =
  | "monitors"
  | "pages"
  | "components"
  | "incidents"
  | "maintenance"
  | "channels"
  | "settings";

export interface NavItem {
  readonly icon: NavIcon;
  readonly id: string;
  readonly label: MessageId;
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
        to: "/admin/monitors",
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
        to: "/admin/pages",
      },
      {
        icon: "components",
        id: "components",
        label: "component_list_title",
        to: "/admin/components",
      },
      {
        icon: "incidents",
        id: "incidents",
        label: "incident_list_title",
        to: "/admin/incidents",
      },
      {
        icon: "maintenance",
        id: "maintenance",
        label: "maintenance_list_title",
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
        to: "/admin/channels",
      },
      {
        icon: "settings",
        id: "settings",
        label: "setting_title",
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
      to: "/admin/settings/setup-check",
    },
  ],
};

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
 * Every page, then, once the query has text, the monitors it finds under the
 * list's search rule, by name under the locale, and the list searched for
 * it; then the actions.
 */
export function paletteGroups(
  query: string,
  monitors: readonly MonitorChoice[],
  locale: string
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
  return [
    ...navigation.map((group) => ({
      id: group.id,
      items: [...group.items, ...(paletteOnly[group.id] ?? [])].map((item) => ({
        item,
        kind: "page" as const,
      })),
      label: group.label,
    })),
    ...found,
    {
      id: "actions",
      items: [
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
      ],
      label: "app_nav_actions",
    },
  ];
}
