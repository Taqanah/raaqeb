/**
 * The icons the primitives need, as inline SVG paths (no icon
 * package; the paths are Lucide's, ISC). Every icon is decorative and hidden
 * from assistive technology; the control it sits in carries the name.
 * `ChevronEndIcon` points along the reading direction and mirrors under RTL;
 * checkmarks, crosses and vertical chevrons never mirror.
 */
import type { ReactNode, SVGProps } from "react";
import { cn } from "./cn.ts";

export type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps): ReactNode {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {children}
    </svg>
  );
}

export function XIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  );
}

/** A save in progress; the caller spins it. */
export function LoaderIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function ChevronUpIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="m18 15-6-6-6 6" />
    </Icon>
  );
}

export function ChevronEndIcon({ className, ...props }: IconProps): ReactNode {
  return (
    <Icon className={cn("rtl:-scale-x-100", className)} {...props}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  );
}

/** The sidebar trigger: a panel on the start side, mirrored under RTL. */
export function PanelStartIcon({ className, ...props }: IconProps): ReactNode {
  return (
    <Icon className={cn("rtl:-scale-x-100", className)} {...props}>
      <rect height="18" rx="2" width="18" x="3" y="3" />
      <path d="M9 3v18" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  );
}

/** Opens elsewhere: an arrow leaving a box, which keeps its direction in both languages, as a link out does. */
export function ExternalLinkIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Icon>
  );
}

/** A monitor's group: a folder. */
export function FolderIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Icon>
  );
}

/** Edit: a pencil. */
export function PencilIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </Icon>
  );
}

/** Duplicate: two sheets. */
export function CopyIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <rect height="14" rx="2" width="14" x="8" y="8" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Icon>
  );
}

/** Check now: two arrows turning. */
export function RefreshIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </Icon>
  );
}

/** Pause: two bars. */
export function PauseIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <rect height="18" rx="1" width="5" x="14" y="3" />
      <rect height="18" rx="1" width="5" x="5" y="3" />
    </Icon>
  );
}

/** Resume: a play triangle; media controls keep their direction in both languages. */
export function PlayIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
    </Icon>
  );
}

/** Delete: a bin. */
export function TrashIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </Icon>
  );
}

/** The keyboard shortcuts: a keyboard. */
export function KeyboardIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M10 8h.01" />
      <path d="M12 12h.01" />
      <path d="M14 8h.01" />
      <path d="M16 12h.01" />
      <path d="M18 8h.01" />
      <path d="M6 8h.01" />
      <path d="M7 16h10" />
      <path d="M8 12h.01" />
      <rect height="16" rx="2" width="20" x="2" y="4" />
    </Icon>
  );
}

/** Sign out: an arrow leaving a door toward the start side, out of the app; right in Arabic, left in English. */
export function LogOutIcon({ className, ...props }: IconProps): ReactNode {
  return (
    <Icon className={cn("ltr:-scale-x-100", className)} {...props}>
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    </Icon>
  );
}

/** Monitors: a pulse line. */
export function ActivityIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    </Icon>
  );
}

/** Status pages: a browser window. */
export function LayoutIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <rect height="18" rx="2" width="18" x="3" y="3" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </Icon>
  );
}

/** Components: blocks, one set apart. */
export function BlocksIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <rect height="7" rx="1" width="7" x="14" y="3" />
      <path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3" />
    </Icon>
  );
}

/** Incidents: a warning triangle. */
export function TriangleAlertIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

/** Maintenance windows: a wrench. */
export function WrenchIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </Icon>
  );
}

/** Notification channels: a bell. */
export function BellIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </Icon>
  );
}

/** Acknowledging an outage, which silences its reminders: a bell struck through. */
export function BellOffIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742" />
      <path d="m2 2 20 20" />
      <path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05" />
    </Icon>
  );
}

/** Settings: a sliders panel. */
export function SlidersIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M21 4h-7" />
      <path d="M10 4H3" />
      <path d="M21 12h-9" />
      <path d="M8 12H3" />
      <path d="M21 20h-5" />
      <path d="M12 20H3" />
      <path d="M14 2v4" />
      <path d="M8 10v4" />
      <path d="M16 18v4" />
    </Icon>
  );
}

/** Lucide `ellipsis`: the per-item menu trigger. */
export function EllipsisIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </Icon>
  );
}

/** Lucide `list`. */
export function ListIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
      <path d="M3 6h.01" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M8 6h13" />
    </Icon>
  );
}

/** The light theme. */
export function SunIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </Icon>
  );
}

/** The dark theme. */
export function MoonIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Icon>
  );
}

/** The theme that follows the system. */
export function MonitorIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <rect height="14" rx="2" width="20" x="2" y="3" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </Icon>
  );
}

/** A webhook channel. */
export function WebhookIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </Icon>
  );
}

/** A month's history: a calendar page. */
export function CalendarIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect height="18" rx="2" width="18" x="3" y="4" />
      <path d="M3 10h18" />
    </Icon>
  );
}

/** A page's feed: the RSS waves, the sign feed readers share for Atom too. */
export function RssIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M4 11a9 9 0 0 1 9 9" />
      <path d="M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1" />
    </Icon>
  );
}

/** An email channel. */
export function MailIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <rect height="16" rx="2" width="20" x="2" y="4" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </Icon>
  );
}

/** A Slack channel: Slack names its channels with a hash. */
export function HashIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M4 9h16" />
      <path d="M4 15h16" />
      <path d="M10 3 8 21" />
      <path d="m16 3-2 18" />
    </Icon>
  );
}

/** A Discord channel. */
export function MessageSquareIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Icon>
  );
}

/** A Telegram channel. */
export function SendIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </Icon>
  );
}

/** SQLite: one file in the data directory. */
export function FileIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </Icon>
  );
}

/** A database server. */
export function DatabaseIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </Icon>
  );
}

/** A history of checks over time. */
export function ChartLineIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="m19 9-5 5-4-4-3 3" />
    </Icon>
  );
}
