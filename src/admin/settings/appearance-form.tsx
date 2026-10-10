/**
 * The appearance page: the four install-wide scales. The theme
 * and the font size are cards that draw their result; the density and the
 * corners are segmented controls with a small drawing each. A choice saves
 * at once, with no save button, and the save re-reads the root loader, so
 * the document's data attributes and the whole admin follow as soon as it
 * is clicked.
 */
import { type ReactNode, type SubmitEvent, useCallback, useRef } from "react";
import { formWidth } from "@/admin/shell/page.tsx";
import { lineOf } from "@/admin/shell/save-flow.ts";
import { SaveLine } from "@/admin/shell/save-footer.tsx";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type Appearance,
  appearanceSchema,
  densities,
  fontSizes,
  radii,
  type Theme,
} from "@/shared/schemas/appearance.ts";
import type { SaveRefusal } from "@/shared/schemas/settings.ts";
import { Card, CardContent } from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { Field, FieldGroup, FieldLabel } from "@/shared/ui/field.tsx";
import { MonitorIcon, MoonIcon, SunIcon } from "@/shared/ui/icons.tsx";
import { OptionCard, OptionCards } from "@/shared/ui/option-card.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { type SaveCall, useSave } from "./use-save.ts";

const messages: Readonly<Record<SaveRefusal, MessageId>> = {
  invalid: "setting_invalid",
  unavailable: "setting_unavailable",
};

/** Light and dark first, then the one that follows the system, as they read left to right in a row of looks. */
const themeOrder: readonly Theme[] = ["light", "dark", "system"];
const themeIcons = { dark: MoonIcon, light: SunIcon, system: MonitorIcon };

/** The sample text's size in each font size card. */
const sampleSizes: Readonly<Record<Appearance["fontSize"], string>> = {
  large: "text-2xl",
  medium: "text-xl",
  small: "text-base",
};

export interface AppearanceFormProps {
  readonly appearance: Appearance;
  readonly onSaved: () => void;
  readonly save: SaveCall<Appearance, SaveRefusal>;
}

export function AppearanceForm({
  appearance,
  onSaved,
  save,
}: AppearanceFormProps): ReactNode {
  const { t } = useMessages();
  const { fail, state, submit } = useSave(save, onSaved);
  const form = useRef<HTMLFormElement>(null);
  // The other scales are read from the form, not the last load, so two quick choices never undo each other; the clicked one is not in it yet.
  const choose = useCallback(
    (scale: keyof Appearance) => (value: unknown) => {
      const current = form.current ? new FormData(form.current) : undefined;
      const parsed = appearanceSchema.safeParse({
        density: current?.get("density"),
        fontSize: current?.get("fontSize"),
        radius: current?.get("radius"),
        theme: current?.get("theme"),
        [scale]: value,
      });
      if (parsed.success) {
        submit(parsed.data);
      } else {
        fail("invalid");
      }
    },
    [fail, submit]
  );
  return (
    <form data-slot="appearance-form" onSubmit={preventSubmit} ref={form}>
      {/* Every settings form sits in a card, as the account, sign-in and export forms do. */}
      <Card className={formWidth}>
        <CardContent>
          <FieldGroup>
            <Field>
              <div className="flex items-baseline justify-between gap-3">
                <FieldLabel id="theme-label">{t("setting_theme")}</FieldLabel>
                <SaveLine line={lineOf(state)} refusals={messages} />
              </div>
              <OptionCards
                aria-labelledby="theme-label"
                className="grid-cols-3"
                data-name="theme"
                defaultValue={appearance.theme}
                name="theme"
                onValueChange={choose("theme")}
              >
                {themeOrder.map((theme) => {
                  const Icon = themeIcons[theme];
                  return (
                    <OptionCard
                      className="flex-col gap-2 p-2"
                      key={theme}
                      value={theme}
                    >
                      <ThemePreview theme={theme} />
                      <span className="flex items-center justify-center gap-1.5 whitespace-nowrap font-medium text-sm max-sm:text-xs [&_svg]:size-icon">
                        <Icon />
                        {t(`setting_theme_${theme}`)}
                      </span>
                    </OptionCard>
                  );
                })}
              </OptionCards>
            </Field>
            <Field>
              <FieldLabel id="fontSize-label">
                {t("setting_font_size")}
              </FieldLabel>
              <OptionCards
                aria-labelledby="fontSize-label"
                className="grid-cols-3"
                data-name="fontSize"
                defaultValue={appearance.fontSize}
                name="fontSize"
                onValueChange={choose("fontSize")}
              >
                {fontSizes.map((size) => (
                  <OptionCard
                    className="flex-col gap-2 p-2"
                    key={size}
                    value={size}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex h-16 items-center justify-center rounded-lg bg-subtle font-semibold",
                        sampleSizes[size]
                      )}
                    >
                      أب Aa
                    </span>
                    <span className="text-center font-medium text-sm">
                      {t(`setting_font_size_${size}`)}
                    </span>
                  </OptionCard>
                ))}
              </OptionCards>
            </Field>
            <div className="grid gap-6 sm:grid-cols-2">
              <Field>
                <FieldLabel id="density-label">
                  {t("setting_density")}
                </FieldLabel>
                <Segmented
                  aria-labelledby="density-label"
                  data-name="density"
                  defaultValue={appearance.density}
                  name="density"
                  onValueChange={choose("density")}
                >
                  {densities.map((density) => (
                    <SegmentedItem
                      className="gap-1 py-2"
                      key={density}
                      value={density}
                    >
                      <span className="flex flex-col items-center gap-1">
                        <DensityMark density={density} />
                        {t(`setting_density_${density}`)}
                      </span>
                    </SegmentedItem>
                  ))}
                </Segmented>
              </Field>
              <Field>
                <FieldLabel id="radius-label">{t("setting_radius")}</FieldLabel>
                <Segmented
                  aria-labelledby="radius-label"
                  data-name="radius"
                  defaultValue={appearance.radius}
                  name="radius"
                  onValueChange={choose("radius")}
                >
                  {radii.map((radius) => (
                    <SegmentedItem className="py-2" key={radius} value={radius}>
                      <span className="flex flex-col items-center gap-1">
                        <RadiusMark radius={radius} />
                        {t(`setting_radius_${radius}`)}
                      </span>
                    </SegmentedItem>
                  ))}
                </Segmented>
              </Field>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>
    </form>
  );
}

/** Enter in the form saves nothing more: every choice has saved already. */
function preventSubmit(event: SubmitEvent<HTMLFormElement>): void {
  event.preventDefault();
}

/** A small window in each theme's own colours, whatever the page's theme is; the system one is half of each. */
function ThemePreview({ theme }: { readonly theme: Theme }): ReactNode {
  if (theme === "system") {
    return (
      <span
        aria-hidden="true"
        className="relative block h-16 overflow-hidden rounded-lg border border-neutral-200"
      >
        <span className="absolute inset-0">
          <Window dark={false} />
        </span>
        <span className="absolute inset-0 [clip-path:inset(0_50%_0_0)]">
          <Window dark />
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block h-16 overflow-hidden rounded-lg border",
        theme === "dark" ? "border-neutral-800" : "border-neutral-200"
      )}
    >
      <Window dark={theme === "dark"} />
    </span>
  );
}

function Window({ dark }: { readonly dark: boolean }): ReactNode {
  const line = dark ? "bg-neutral-700" : "bg-neutral-200";
  return (
    <span
      className={cn("flex size-full", dark ? "bg-neutral-950" : "bg-white")}
    >
      <span
        className={cn(
          "flex w-1/4 flex-col gap-1 p-1.5",
          dark ? "bg-neutral-900" : "bg-neutral-100"
        )}
      >
        <span
          className={cn(
            "h-1 w-3/5 rounded-full",
            dark ? "bg-teal-400" : "bg-teal-700"
          )}
        />
        <span className={cn("h-1 rounded-full", line)} />
        <span className={cn("h-1 rounded-full", line)} />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 p-2">
        <span className={cn("h-1 w-3/5 rounded-full", line)} />
        <span className={cn("h-1 rounded-full", line)} />
        <span className={cn("h-1 w-4/5 rounded-full", line)} />
      </span>
    </span>
  );
}

/** Four lines, closer or further apart. */
function DensityMark({
  density,
}: {
  readonly density: Appearance["density"];
}): ReactNode {
  const gap = { comfortable: 5, compact: 3, spacious: 7 }[density];
  return (
    <svg aria-hidden="true" className="size-4" viewBox="0 0 16 16">
      {[0, 1, 2].map((row) => (
        <path
          d={`M2 ${8 + (row - 1) * gap}H14`}
          key={row}
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}

/** A box with no, some or round corners. */
function RadiusMark({
  radius,
}: {
  readonly radius: Appearance["radius"];
}): ReactNode {
  const round = { large: 5, medium: 2.5, none: 0 }[radius];
  return (
    <svg aria-hidden="true" className="size-4" viewBox="0 0 16 16">
      <rect
        fill="none"
        height="10"
        rx={round}
        stroke="currentColor"
        strokeWidth={1.5}
        width="13"
        x="1.5"
        y="3"
      />
    </svg>
  );
}
