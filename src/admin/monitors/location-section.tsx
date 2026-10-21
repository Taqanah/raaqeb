/**
 * The monitor form's locations (CONTEXT.md "Location", "Confirmation
 * count"): where the monitor is checked from, how many of them must see it
 * down, and whether its credentials go to its probes. Shown only once the
 * install has a probe, so a form without one is as it was.
 */
import { type ReactNode, useCallback } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  checkableByProbe,
  type MonitorFormOptions,
  mainLocation,
} from "@/shared/schemas/monitor.ts";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import {
  FlagField,
  Problem,
  Section,
  type SectionProps,
} from "./form-parts.tsx";

export function LocationsSection({
  draft,
  errors,
  onField,
  onFlag,
  onLocation,
  probes,
}: SectionProps & {
  readonly onLocation: (id: string, on: boolean) => void;
  readonly probes: MonitorFormOptions["probes"];
}): ReactNode {
  const { t } = useMessages();
  if (probes.length === 0) {
    return null;
  }
  if (!checkableByProbe(draft.type)) {
    return (
      <Section slot="locations" title={t("monitor_section_locations")}>
        <p className="text-muted-foreground text-sm">
          {t("monitor_locations_unsupported")}
        </p>
      </Section>
    );
  }
  const ticked = draft.locations.length;
  const probed = draft.locations.some((id) => id !== mainLocation);
  const counts = Array.from({ length: ticked }, (_, at) => at + 1);
  return (
    <Section
      description={t("monitor_locations_hint")}
      slot="locations"
      title={t("monitor_section_locations")}
    >
      <FieldGroup className="gap-3">
        <div className="flex flex-col gap-3" data-slot="monitor-locations">
          <LocationChoice
            checked={draft.locations.includes(mainLocation)}
            id={mainLocation}
            label={t("monitor_location_main")}
            onLocation={onLocation}
          />
          {probes.map((probe) => (
            <LocationChoice
              checked={draft.locations.includes(probe.id)}
              id={probe.id}
              key={probe.id}
              label={probe.name}
              onLocation={onLocation}
            />
          ))}
        </div>
        <Problem errors={errors} path="locations" />
      </FieldGroup>
      {ticked > 1 ? (
        <Field className="max-w-xs">
          <FieldLabel htmlFor="confirmations">
            {t("monitor_confirmations")}
          </FieldLabel>
          <NativeSelect
            className="w-full"
            id="confirmations"
            name="confirmations"
            onChange={onField}
            value={String(Math.min(draft.confirmations, ticked))}
          >
            {counts.map((count) => (
              <NativeSelectOption key={count} value={String(count)}>
                {t("monitor_confirmations_option", { count, total: ticked })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>{t("monitor_confirmations_hint")}</FieldDescription>
        </Field>
      ) : null}
      {probed ? (
        <FieldGroup className="gap-1">
          <FlagField
            checked={draft.shareCredentials}
            hint={t("monitor_share_credentials_hint")}
            label={t("monitor_share_credentials")}
            name="shareCredentials"
            onFlag={onFlag}
            slot="monitor-share-credentials"
          />
          <Problem errors={errors} path="shareCredentials" />
          {draft.type === "http" &&
          !draft.shareCredentials &&
          (draft.auth !== "none" ||
            draft.clientCertificate.trim() !== "" ||
            draft.headers.length > 0 ||
            draft.proxyUser.trim() !== "") ? (
            <p
              className="text-sm text-status-degraded-text"
              data-slot="monitor-share-credentials-warning"
            >
              {t("monitor_share_credentials_warning")}
            </p>
          ) : null}
        </FieldGroup>
      ) : null}
    </Section>
  );
}

function LocationChoice({
  checked,
  id,
  label,
  onLocation,
}: {
  readonly checked: boolean;
  readonly id: string;
  readonly label: string;
  readonly onLocation: (id: string, on: boolean) => void;
}): ReactNode {
  const change = useCallback(
    (on: boolean) => onLocation(id, on),
    [id, onLocation]
  );
  const field = `location-${id}`;
  return (
    <Field orientation="horizontal">
      <Checkbox
        checked={checked}
        data-location={id}
        id={field}
        onCheckedChange={change}
      />
      <FieldLabel htmlFor={field}>
        <bdi>{label}</bdi>
      </FieldLabel>
    </Field>
  );
}
