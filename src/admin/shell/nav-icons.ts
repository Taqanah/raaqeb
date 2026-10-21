/** The icon of every sidebar page and palette action, shared so the two menus read alike. */
import type { ReactNode } from "react";
import {
  ActivityIcon,
  BellIcon,
  BlocksIcon,
  ChartLineIcon,
  HistoryIcon,
  type IconProps,
  KeyboardIcon,
  LayoutIcon,
  LogOutIcon,
  PlusIcon,
  SlidersIcon,
  TriangleAlertIcon,
  UsersIcon,
  WrenchIcon,
} from "@/shared/ui/icons.tsx";
import type { NavIcon, PaletteAction } from "./navigation.ts";

export const navIcons: Readonly<
  Record<NavIcon | PaletteAction, (props: IconProps) => ReactNode>
> = {
  audit: HistoryIcon,
  channels: BellIcon,
  components: BlocksIcon,
  incidents: TriangleAlertIcon,
  maintenance: WrenchIcon,
  monitors: ActivityIcon,
  new_monitor: PlusIcon,
  pages: LayoutIcon,
  reports: ChartLineIcon,
  settings: SlidersIcon,
  shortcuts: KeyboardIcon,
  sign_out: LogOutIcon,
  team: UsersIcon,
};
