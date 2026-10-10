/**
 * The sample page of the design language: every
 * primitive, in the locale the design route was asked for, so a reviewer can
 * look at both locales, both themes and each appearance scale. Served by the
 * dev-only design route. Section captions are the primitives' code names as
 * tokens; the copy inside them is product copy from the catalog and the
 * formatting helpers, never sample prose.
 */
import { type ReactNode, useCallback, useMemo } from "react";
import {
  formatDateTime,
  formatPercent,
  formatUnit,
} from "@/shared/i18n/format.ts";
import { type Direction, type Locale, locales } from "@/shared/i18n/locale.ts";
import { catalogFromJson, createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider, useMessages } from "@/shared/i18n/react.tsx";
import {
  type Appearance,
  densities,
  fontSizes,
  radii,
  themes,
} from "@/shared/schemas/appearance.ts";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/shared/ui/alert-dialog.tsx";
import type { appearanceAttributes } from "@/shared/ui/appearance.ts";
import { Badge } from "@/shared/ui/badge.tsx";
import { Button } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog.tsx";
import { DirectionProvider } from "@/shared/ui/direction.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/shared/ui/empty.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import {
  ActivityIcon,
  ChevronDownIcon,
  SlidersIcon,
} from "@/shared/ui/icons.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { Kbd } from "@/shared/ui/kbd.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group.tsx";
import { Separator } from "@/shared/ui/separator.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/shared/ui/sheet.tsx";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar.tsx";
import { Switch } from "@/shared/ui/switch.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table.tsx";
import { Textarea } from "@/shared/ui/textarea.tsx";
import { Token } from "@/shared/ui/token.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/ui/tooltip.tsx";

export interface DesignSampleProps {
  /** The compiled catalog of `locale`, as JSON text. */
  readonly catalog: string;
  readonly dir: Direction;
  readonly locale: Locale;
}

/** The sample under its own catalog and direction, so `?locale=en` works without an install language. */
export function DesignSample({
  catalog,
  dir,
  locale,
}: DesignSampleProps): ReactNode {
  const i18n = useMemo(
    () => createMessages(locale, catalogFromJson(catalog)),
    [locale, catalog]
  );
  return (
    <MessagesProvider i18n={i18n}>
      <DirectionProvider direction={dir}>
        <div dir={dir} lang={locale}>
          <Sample />
        </div>
      </DirectionProvider>
    </MessagesProvider>
  );
}

// Three rows for the table: one per status colour that a monitor list shows.
const sampleRows = [
  {
    label: "app_name",
    ms: 182,
    url: "https://api.raaqeb.dev/health",
    variant: "up",
  },
  {
    label: "monitor_degraded",
    ms: 1240,
    url: "https://pay.raaqeb.dev",
    variant: "degraded",
  },
  {
    label: "monitor_outage",
    ms: 0,
    url: "https://mail.raaqeb.dev",
    variant: "down",
  },
] as const;

// A fixed instant, so the screenshots never change with the clock.
const sampleInstant = Date.UTC(2026, 8, 11, 6, 49);
const sampleZone = "Asia/Riyadh";

function Section({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-medium text-muted-foreground text-xs">
        <Token>{name}</Token>
      </h2>
      {children}
    </section>
  );
}

type AppearanceAttribute = keyof ReturnType<typeof appearanceAttributes>;

/** One choice on the bar: clicking it writes the attribute on the document, live. */
function AppearanceChoice({
  attribute,
  children,
  value,
}: {
  attribute: AppearanceAttribute;
  children: ReactNode;
  value: string;
}) {
  const apply = useCallback(() => {
    document.documentElement.setAttribute(attribute, value);
  }, [attribute, value]);
  return (
    <Button onClick={apply} size="sm" variant="ghost">
      {children}
    </Button>
  );
}

/** The floating bar: theme and scales applied to the document, live, and the locale links. */
function AppearanceBar() {
  const { locale, t } = useMessages();
  const groups: ReadonlyArray<{
    attribute: AppearanceAttribute;
    label: string;
    values: ReadonlyArray<{
      id: Parameters<typeof t>[0];
      value: Appearance[keyof Appearance];
    }>;
  }> = [
    {
      attribute: "data-theme",
      label: t("setting_theme"),
      values: themes.map((value) => ({ id: `setting_theme_${value}`, value })),
    },
    {
      attribute: "data-font-size",
      label: t("setting_font_size"),
      values: fontSizes.map((value) => ({
        id: `setting_font_size_${value}`,
        value,
      })),
    },
    {
      attribute: "data-density",
      label: t("setting_density"),
      values: densities.map((value) => ({
        id: `setting_density_${value}`,
        value,
      })),
    },
    {
      attribute: "data-radius",
      label: t("setting_radius"),
      values: radii.map((value) => ({ id: `setting_radius_${value}`, value })),
    },
  ];
  return (
    <div className="sticky top-4 z-40 mx-auto flex w-fit max-w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-popover/90 px-4 py-2 shadow-md backdrop-blur">
      {groups.map((group) => (
        <div className="flex items-center gap-1.5" key={group.attribute}>
          <span className="text-muted-foreground text-xs">{group.label}</span>
          {group.values.map(({ id, value }) => (
            <AppearanceChoice
              attribute={group.attribute}
              key={value}
              value={value}
            >
              {t(id)}
            </AppearanceChoice>
          ))}
        </div>
      ))}
      <Separator className="h-5" orientation="vertical" />
      <div className="flex items-center gap-1">
        {locales.map((other) => (
          <Button
            aria-current={other === locale ? "page" : undefined}
            key={other}
            nativeButton={false}
            render={<a href={`/design?locale=${other}`} />}
            size="sm"
            variant={other === locale ? "secondary" : "ghost"}
          >
            <Token>{other}</Token>
          </Button>
        ))}
      </div>
    </div>
  );
}

function Sample() {
  const { locale, t } = useMessages();
  const when = formatDateTime(locale, sampleInstant, {
    calendar: "gregorian",
    clock: "12h",
    timeZone: sampleZone,
  });
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 p-6 pb-24">
      <AppearanceBar />

      <Section name="type">
        <div className="flex flex-col gap-2">
          <p className="font-semibold text-3xl">
            {formatPercent(locale, 0.9998)}
          </p>
          <h1 className="font-semibold text-lg">{t("app_name")}</h1>
          <p className="font-medium text-base">{t("maintenance_window")}</p>
          <p className="text-sm">{when}</p>
          <p className="text-muted-foreground text-xs">
            {formatUnit(locale, 245, "millisecond")}
          </p>
          <p className="text-sm">
            {t("monitor_outage")} <Token>https://api.raaqeb.dev/health</Token>{" "}
            <Token>HTTP 503</Token> {formatUnit(locale, 30, "second")}
          </p>
        </div>
      </Section>

      <Section name="status">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="up">{formatPercent(locale, 1)}</Badge>
          <Badge variant="degraded">{t("monitor_degraded")}</Badge>
          <Badge variant="partial">{t("component_level_partial_outage")}</Badge>
          <Badge variant="down">{t("monitor_outage")}</Badge>
          <Badge variant="maintenance">{t("maintenance_window")}</Badge>
          <Badge variant="paused">{t("monitor_paused")}</Badge>
          <Badge>{t("app_name")}</Badge>
          <Badge variant="secondary">{t("app_name")}</Badge>
          <Badge variant="outline">{t("app_name")}</Badge>
        </div>
      </Section>

      <Section name="button">
        <div className="flex flex-wrap items-center gap-2">
          <Button>
            {t("app_save")}
            <Kbd>S</Kbd>
          </Button>
          <Button variant="outline">{t("app_cancel")}</Button>
          <Button variant="secondary">{t("app_search")}</Button>
          <Button variant="ghost">{t("app_close")}</Button>
          <Button variant="destructive">{t("app_delete")}</Button>
          <Button variant="link">{t("app_name")}</Button>
          <Button size="icon" variant="outline">
            <ChevronDownIcon />
          </Button>
          <Button disabled>{t("app_save")}</Button>
        </div>
      </Section>

      <Section name="field">
        <FieldGroup className="max-w-md">
          <Field>
            <FieldLabel htmlFor="sample-name">{t("app_name")}</FieldLabel>
            <Input defaultValue={t("app_name")} id="sample-name" />
            <FieldDescription>{when}</FieldDescription>
          </Field>
          <Field data-invalid="true">
            <FieldLabel htmlFor="sample-url">
              <Token>URL</Token>
            </FieldLabel>
            <Input
              aria-invalid="true"
              defaultValue="https://api.raaqeb.dev"
              id="sample-url"
              variant="token"
            />
            <FieldError>{t("monitor_outage")}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="sample-notes">
              {t("maintenance_window")}
            </FieldLabel>
            <Textarea defaultValue={when} id="sample-notes" />
          </Field>
          <Field>
            <FieldLabel htmlFor="sample-density">
              {t("setting_density")}
            </FieldLabel>
            <NativeSelect defaultValue="comfortable" id="sample-density">
              {densities.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {t(`setting_density_${value}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field orientation="horizontal">
            <Checkbox defaultChecked id="sample-check" />
            <FieldLabel htmlFor="sample-check">
              {t("monitor_paused")}
            </FieldLabel>
          </Field>
          <Field>
            <FieldLabel>{t("setting_radius")}</FieldLabel>
            <RadioGroup defaultValue="medium">
              {radii.map((value) => (
                <Field key={value} orientation="horizontal">
                  <RadioGroupItem id={`sample-radius-${value}`} value={value} />
                  <FieldLabel htmlFor={`sample-radius-${value}`}>
                    {t(`setting_radius_${value}`)}
                  </FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          </Field>
          <Field orientation="horizontal">
            <Switch defaultChecked id="sample-switch" />
            <FieldLabel htmlFor="sample-switch">
              {t("setting_theme_dark")}
            </FieldLabel>
          </Field>
        </FieldGroup>
      </Section>

      <Section name="overlay">
        <div className="flex flex-wrap items-center gap-2">
          <Dialog>
            <DialogTrigger render={<Button variant="outline" />}>
              <Token>Dialog</Token>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("maintenance_window")}</DialogTitle>
                <DialogDescription>{when}</DialogDescription>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor="sample-dialog-input">
                  {t("app_name")}
                </FieldLabel>
                <Input id="sample-dialog-input" />
              </Field>
              <DialogFooter showCloseButton>
                <Button>{t("app_save")}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive" />}>
              <Token>AlertDialog</Token>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("app_delete")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("monitor_outage")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("app_cancel")}</AlertDialogCancel>
                <AlertDialogAction variant="destructive">
                  {t("app_delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Sheet>
            <SheetTrigger render={<Button variant="outline" />}>
              <Token>Sheet</Token>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>{t("maintenance_window")}</SheetTitle>
                <SheetDescription>{when}</SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" />}>
              <Token>Tooltip</Token>
            </TooltipTrigger>
            <TooltipContent>
              {t("app_search")}
              <Kbd>/</Kbd>
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <Token>DropdownMenu</Token>
              <ChevronDownIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>
                {t("app_save")}
                <DropdownMenuShortcut>
                  <Kbd>S</Kbd>
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>{t("monitor_paused")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                {t("app_delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Section>

      <Section name="sidebar">
        <div className="w-sidebar rounded-2xl bg-sidebar p-2 text-sidebar-foreground shadow-xs ring-1 ring-sidebar-border">
          <SidebarGroup>
            <SidebarGroupLabel>{t("app_nav_monitoring")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive>
                    <ActivityIcon />
                    <span>{t("monitor_list_title")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton>
                    <SlidersIcon />
                    <span>{t("setting_title")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </div>
      </Section>

      <Section name="card">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t("app_name")}</CardTitle>
              <CardDescription>
                <Token>https://status.raaqeb.dev</Token>
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-baseline gap-4">
              <span className="font-semibold text-2xl tabular-nums">
                {formatPercent(locale, 0.9998)}
              </span>
              <span className="text-muted-foreground">
                {formatUnit(locale, 245, "millisecond")}
              </span>
            </CardContent>
            <CardFooter className="justify-between">
              <Badge variant="up">{formatPercent(locale, 1)}</Badge>
              <span className="text-muted-foreground text-xs">{when}</span>
            </CardFooter>
          </Card>
        </div>
      </Section>

      <Section name="table">
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("app_name")}</TableHead>
                <TableHead>
                  <Token>URL</Token>
                </TableHead>
                <TableHead className="text-end">
                  <Token>ms</Token>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sampleRows.map((row) => (
                <TableRow key={row.url}>
                  <TableCell>
                    <Badge variant={row.variant}>
                      {row.variant === "up"
                        ? formatPercent(locale, 1)
                        : t(row.label)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Token>{row.url}</Token>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatUnit(locale, row.ms, "millisecond")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Section>

      <Section name="alert">
        <div className="flex flex-col gap-3">
          <Alert>
            <AlertTitle>{t("maintenance_window")}</AlertTitle>
            <AlertDescription>{when}</AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <AlertTitle>{t("monitor_outage")}</AlertTitle>
            <AlertDescription>
              <Token>HTTP 503</Token>
            </AlertDescription>
          </Alert>
        </div>
      </Section>

      <Section name="empty">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("monitor_paused")}</EmptyTitle>
            <EmptyDescription>{when}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button>
              {t("app_save")}
              <Kbd>N</Kbd>
            </Button>
          </EmptyContent>
        </Empty>
      </Section>
    </main>
  );
}
