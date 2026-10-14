/**
 * The admin shell: the floating sidebar with the
 * palette button and the grouped navigation, the release banner, and the
 * page below, whose own row holds the sidebar trigger. It owns the keyboard
 * map's handlers, the command palette and the shortcut sheet.
 */
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { MonitorChoicesResult } from "@/shared/schemas/monitor.ts";
import type { Release } from "@/shared/schemas/release.ts";
import { Button } from "@/shared/ui/button.tsx";
import { LogOutIcon, SearchIcon } from "@/shared/ui/icons.tsx";
import { Kbd, KbdGroup } from "@/shared/ui/kbd.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@/shared/ui/sidebar.tsx";
import { keyLabel } from "./keyboard.ts";
import { navIcons } from "./nav-icons.ts";
import { navigation, type PaletteItem } from "./navigation.ts";
import { Palette } from "./palette.tsx";
import { ReleaseBanner } from "./release-banner.tsx";
import { ShortcutSheet } from "./shortcut-sheet.tsx";
import { Toasts } from "./toasts.tsx";
import { useKeyboard } from "./use-keyboard.ts";

const applePlatform = /Mac|iPhone|iPad/;
const monitorsPath = "/admin/monitors";
const newMonitorPath = "/admin/monitors/new";
const signOutPath = "/sign-out";

export interface AdminShellProps {
  readonly children: ReactNode;
  readonly operatorEmail: string;
  /** The palette's read of every monitor's name and target; nothing when the session check redirected. */
  readonly readMonitors: () => Promise<MonitorChoicesResult | undefined>;
  readonly release: Release | undefined;
  /** What the sidebar cookie said, so the first paint matches the last visit. */
  readonly sidebarOpen: boolean;
}

export function AdminShell({
  children,
  operatorEmail,
  readMonitors,
  release,
  sidebarOpen,
}: AdminShellProps): ReactNode {
  return (
    <Toasts>
      <SidebarProvider defaultOpen={sidebarOpen}>
        <ShellInner
          operatorEmail={operatorEmail}
          readMonitors={readMonitors}
          release={release}
        >
          {children}
        </ShellInner>
      </SidebarProvider>
    </Toasts>
  );
}

function ShellInner({
  children,
  operatorEmail,
  readMonitors,
  release,
}: Omit<AdminShellProps, "sidebarOpen">): ReactNode {
  const { locale, t } = useMessages();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { setOpenMobile, toggleSidebar } = useSidebar();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // The platform is read after mount: the server cannot know it. A Mac's ⌘ reads alike in both languages; Ctrl takes the operator's.
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(applePlatform.test(navigator.platform));
  }, []);
  // A new history entry carries a new key: a link, the palette and a shortcut make one, a timer's invalidate does not.
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
        if (fromLocation?.state.__TSR_key !== toLocation.state.__TSR_key) {
          setOpenMobile(false);
        }
      }),
    [router, setOpenMobile]
  );
  // A link to the page already open is no new entry, only a reload the router cannot tell from a timer's, so those links close the sheet themselves.
  const closeSheet = useCallback(() => setOpenMobile(false), [setOpenMobile]);
  const modifier = mac ? "⌘" : t("app_key_ctrl");

  const go = useCallback(
    (href: string) => {
      router.navigate({ href }).catch(() => undefined);
    },
    [router]
  );
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openSheet = useCallback(() => setSheetOpen(true), []);
  const handlers = useMemo(
    () => ({
      close: () => {
        setPaletteOpen(false);
        setSheetOpen(false);
      },
      // N creates a monitor from the monitor list only; elsewhere the key is not taken.
      new_monitor:
        pathname === monitorsPath ? () => go(newMonitorPath) : undefined,
      palette: () => setPaletteOpen((open) => !open),
      // Presses the Save of the form holding the focus, which does nothing while it rests.
      save: () => {
        document.activeElement
          ?.closest("form")
          ?.querySelector<HTMLElement>("[data-save]")
          ?.click();
      },
      search: () => {
        const field = document.querySelector<HTMLElement>("[data-search]");
        if (field) {
          field.focus();
        } else {
          openPalette();
        }
      },
      shortcuts: openSheet,
      sidebar: toggleSidebar,
    }),
    [go, openPalette, openSheet, pathname, toggleSidebar]
  );
  useKeyboard(handlers);

  const select = useCallback(
    (item: PaletteItem) => {
      if (item.kind === "page") {
        go(item.item.to);
        return;
      }
      if (item.kind === "monitor") {
        router
          .navigate({
            params: { id: item.monitor.id },
            to: "/admin/monitors/$id",
          })
          .catch(() => undefined);
        return;
      }
      if (item.kind === "search") {
        router
          .navigate({ search: { q: item.query }, to: monitorsPath })
          .catch(() => undefined);
        return;
      }
      switch (item.action) {
        case "new_monitor":
          go(newMonitorPath);
          return;
        case "shortcuts":
          openSheet();
          return;
        case "sign_out":
          go(signOutPath);
          return;
        default:
          return;
      }
    },
    [go, openSheet, router]
  );

  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <Link
            className="flex h-control items-center rounded-lg px-3 font-semibold text-base"
            onClick={closeSheet}
            to="/admin/monitors"
          >
            {t("app_name")}
          </Link>
          {/* Search is global, so it sits with the navigation, not in a page's row. */}
          <Button
            aria-keyshortcuts="Control+K Meta+K"
            className="w-full justify-start bg-background text-muted-foreground"
            data-slot="palette-trigger"
            onClick={openPalette}
            variant="outline"
          >
            <SearchIcon />
            {/* The word takes the free space, so the chip sits at the end in both directions; the group's own LTR would turn an ms-auto left. */}
            <span className="flex-1 text-start">{t("app_search")}</span>
            {/* A touch screen has no keys to press. */}
            <KbdGroup aria-hidden="true" className="pointer-coarse:hidden">
              <Kbd>{modifier}</Kbd>
              <Kbd>{keyLabel("KeyK", false, locale)}</Kbd>
            </KbdGroup>
          </Button>
        </SidebarHeader>
        <SidebarContent>
          {/* The sidebar itself is the navigation landmark. */}
          <div>
            {navigation.map((group) => (
              <SidebarGroup key={group.id}>
                {/* A group of one needs no heading. */}
                {group.items.length > 1 ? (
                  <SidebarGroupLabel>{t(group.label)}</SidebarGroupLabel>
                ) : null}
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => {
                      const Icon = navIcons[item.icon];
                      const active =
                        pathname === item.to ||
                        pathname.startsWith(`${item.to}/`);
                      return (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            isActive={active}
                            render={
                              <Link
                                aria-current={active ? "page" : undefined}
                                data-nav={item.id}
                                onClick={closeSheet}
                                to={item.to}
                              />
                            }
                          >
                            <Icon />
                            <span>{t(item.label)}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </div>
        </SidebarContent>
        <SidebarFooter className="border-sidebar-border border-t">
          {/* The email is the operator's name here, not a machine token: isolated, not monospace. */}
          <bdi
            className="max-w-full self-start truncate px-3 pt-1 text-muted-foreground text-xs"
            dir="ltr"
            title={operatorEmail}
          >
            {operatorEmail}
          </bdi>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className="text-destructive-text hover:bg-destructive/10 hover:text-destructive-text"
                render={<Link to={signOutPath} />}
              >
                <LogOutIcon />
                <span>{t("auth_sign_out")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      {/* A container, so a page's width steps follow the space beside the sidebar, not the screen. */}
      <SidebarInset className="@container">
        {release ? <ReleaseBanner release={release} /> : null}
        {children}
      </SidebarInset>
      <Palette
        onOpenChange={setPaletteOpen}
        onSelect={select}
        open={paletteOpen}
        readMonitors={readMonitors}
      />
      <ShortcutSheet
        modifier={modifier}
        onOpenChange={setSheetOpen}
        open={sheetOpen}
      />
    </>
  );
}
