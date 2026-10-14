/**
 * The floating sidebar of direction B: a grey
 * panel on the start side with grouped navigation, collapsing off-canvas on
 * Ctrl or Cmd+B and becoming a sheet on narrow screens. A trimmed copy of
 * shadcn's base-nova sidebar: one variant (floating), one side (start, so
 * it mirrors under RTL), no rail, sub-menus, badges or skeletons; the
 * keyboard binding lives in the admin shell's map, not here. The open state
 * survives a reload through the `sidebar_state` cookie the registry uses,
 * read by the shell's loader so the first paint is right.
 */
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Button, type ButtonProps } from "./button.tsx";
import { cn } from "./cn.ts";
import { PanelStartIcon } from "./icons.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./sheet.tsx";
import { useIsMobile } from "./use-mobile.ts";

export const sidebarCookieName = "sidebar_state";
const sidebarCookieMaxAge = 60 * 60 * 24 * 7;

interface SidebarContextValue {
  readonly isMobile: boolean;
  readonly open: boolean;
  readonly openMobile: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly setOpenMobile: (open: boolean) => void;
  readonly state: "expanded" | "collapsed";
  readonly toggleSidebar: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }
  return context;
}

/** Whether the cookie says the sidebar was left open; open when it says nothing. */
export function sidebarOpenFromCookie(
  cookie: string | null | undefined
): boolean {
  const pair = (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sidebarCookieName}=`));
  return pair !== `${sidebarCookieName}=false`;
}

function SidebarProvider({
  defaultOpen = true,
  className,
  style,
  children,
  ...props
}: ComponentProps<"div"> & { defaultOpen?: boolean }) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = useState(false);
  const [open, setOpenState] = useState(defaultOpen);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    // biome-ignore lint/suspicious/noDocumentCookie: one plain cookie, written synchronously on every browser; the Cookie Store API is async and not everywhere
    document.cookie = `${sidebarCookieName}=${next}; path=/; max-age=${sidebarCookieMaxAge}; samesite=lax`;
  }, []);
  const toggleSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile((current) => !current);
    } else {
      // The panel goes inert as it closes; a focus inside it would fall to the page, so it moves to the toggle first.
      const panel = document.querySelector("[data-slot=sidebar-container]");
      if (open && panel?.contains(document.activeElement)) {
        document
          .querySelector<HTMLElement>("[data-slot=sidebar-trigger]")
          ?.focus();
      }
      setOpen(!open);
    }
  }, [isMobile, open, setOpen]);
  const value = useMemo<SidebarContextValue>(
    () => ({
      isMobile,
      open,
      openMobile,
      setOpen,
      setOpenMobile,
      state: open ? "expanded" : "collapsed",
      toggleSidebar,
    }),
    [isMobile, open, openMobile, setOpen, toggleSidebar]
  );
  return (
    <SidebarContext.Provider value={value}>
      <div
        className={cn("group/sidebar-wrapper flex min-h-svh w-full", className)}
        data-slot="sidebar-wrapper"
        style={style}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Sidebar({ className, children, ...props }: ComponentProps<"div">) {
  const { t } = useMessages();
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    return (
      <Sheet onOpenChange={setOpenMobile} open={openMobile}>
        <SheetContent
          className="w-72 bg-sidebar p-0 text-sidebar-foreground"
          data-mobile="true"
          data-slot="sidebar"
          side="start"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("app_navigation")}</SheetTitle>
            <SheetDescription>{t("app_navigation")}</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-slot="sidebar"
      data-state={state}
    >
      {/* The gap keeps the page beside the panel; it closes when the panel slides away. */}
      <div
        className="relative w-sidebar bg-transparent transition-[width] duration-200 ease-out-quart group-data-[state=collapsed]:w-0"
        data-slot="sidebar-gap"
      />
      <div
        className={cn(
          "fixed inset-y-0 start-0 z-10 hidden h-svh w-sidebar p-2 transition-[transform,opacity] duration-200 ease-out-quart group-data-[state=collapsed]:-translate-x-full group-data-[state=collapsed]:opacity-0 md:flex rtl:group-data-[state=collapsed]:translate-x-full",
          className
        )}
        data-slot="sidebar-container"
        inert={state === "collapsed"}
        {...props}
      >
        <div
          className="flex size-full flex-col rounded-2xl bg-sidebar ring-line"
          data-slot="sidebar-inner"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: ComponentProps<typeof Button>) {
  const { t } = useMessages();
  const { toggleSidebar } = useSidebar();
  const toggle = useCallback<NonNullable<ButtonProps["onClick"]>>(
    (event) => {
      onClick?.(event);
      toggleSidebar();
    },
    [onClick, toggleSidebar]
  );
  return (
    <Button
      className={cn(className)}
      data-slot="sidebar-trigger"
      onClick={toggle}
      size="icon"
      variant="ghost"
      {...props}
    >
      <PanelStartIcon />
      <span className="sr-only">{t("app_sidebar_toggle")}</span>
    </Button>
  );
}

function SidebarInset({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "relative flex w-full min-w-0 flex-1 flex-col bg-background",
        className
      )}
      data-slot="sidebar-inset"
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-slot="sidebar-header"
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("mt-auto flex flex-col gap-2 p-2", className)}
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-0 overflow-auto",
        className
      )}
      data-slot="sidebar-content"
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      data-slot="sidebar-group"
      {...props}
    />
  );
}

function SidebarGroupLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-2 font-medium text-sidebar-foreground/70 text-xs",
        className
      )}
      data-slot="sidebar-group-label"
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("w-full text-sm", className)}
      data-slot="sidebar-group-content"
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
      data-slot="sidebar-menu"
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      className={cn("group/menu-item relative", className)}
      data-slot="sidebar-menu-item"
      {...props}
    />
  );
}

/** A row of the menu: a button by default, or whatever `render` gives (a link). */
function SidebarMenuButton({
  render,
  isActive = false,
  className,
  ...props
}: useRender.ComponentProps<"button"> &
  ComponentProps<"button"> & { isActive?: boolean }): ReactNode {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(
          "flex h-control w-full items-center gap-2 overflow-hidden rounded-lg px-3 text-start text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground [&>span:last-child]:truncate [&_svg]:size-icon [&_svg]:shrink-0",
          className
        ),
      },
      props
    ),
    render,
    state: { active: isActive, slot: "sidebar-menu-button" },
  });
}

export {
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
  SidebarTrigger,
};
