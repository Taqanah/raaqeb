/**
 * The export and import page. The export
 * is a plain GET form, so the browser saves the file as it streams; the page
 * says the file holds every credential in clear. The import sends the chosen
 * file as the request's body and words what came back.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { formatBytes, formatNumber } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  exportFileName,
  exportModes,
  type ImportAnswer,
  type ImportRefusal,
  importAnswerSchema,
} from "@/shared/schemas/export.ts";
import {
  type ExportRefusal,
  type ExportSizes,
  exportPath,
  importPath,
} from "@/shared/schemas/export-page.ts";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert.tsx";
import { Button } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import {
  ChartLineIcon,
  ListIcon,
  TriangleAlertIcon,
} from "@/shared/ui/icons.tsx";
import {
  OptionCard,
  OptionCardBody,
  OptionCards,
} from "@/shared/ui/option-card.tsx";
import { Token } from "@/shared/ui/token.tsx";

const modeLabels: Readonly<Record<(typeof exportModes)[number], MessageId>> = {
  configuration: "setting_export_mode_configuration",
  full: "setting_export_mode_full",
};

/** What each mode's file holds, under its name. */
const modeNotes: Readonly<Record<(typeof exportModes)[number], MessageId>> = {
  configuration: "setting_export_mode_configuration_note",
  full: "setting_export_mode_full_note",
};

const exportRefusals: Readonly<Record<ExportRefusal, MessageId>> = {
  busy: "setting_export_busy",
  unavailable: "setting_export_unavailable",
  unreadable: "setting_export_unreadable",
};

export interface ExportCardProps {
  /** Why the last download could not start, from the page's search. */
  readonly record: string | undefined;
  readonly refused: ExportRefusal | undefined;
  /** Each mode's file size, read after the page opens; none while it is read. */
  readonly sizes: ExportSizes | undefined;
}

export function ExportCard({
  record,
  refused,
  sizes,
}: ExportCardProps): ReactNode {
  const { locale, t } = useMessages();
  // The size under each mode's line, so the choice is made knowing it; nothing when the export cannot start, which the download says.
  const sizeOf = (mode: (typeof exportModes)[number]) => {
    if (!sizes) {
      return t("setting_export_size_reading");
    }
    return sizes.ok
      ? t("setting_export_size", { size: formatBytes(locale, sizes[mode]) })
      : undefined;
  };
  return (
    <Card data-slot="export-card">
      <CardHeader divided>
        <CardTitle>{t("setting_export")}</CardTitle>
        <CardDescription>{t("setting_export_lead")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={exportPath} method="get">
          <FieldGroup>
            {/* Each mode a card with what the file holds. */}
            <OptionCards
              aria-label={t("setting_export")}
              className="sm:grid-cols-2"
              data-name="mode"
              defaultValue="full"
              name="mode"
            >
              {exportModes.map((mode) => (
                <OptionCard className="gap-3 pe-8" key={mode} value={mode}>
                  <OptionCardBody
                    description={
                      <>
                        {t(modeNotes[mode])}
                        <span
                          className="mt-1 block font-medium text-foreground tabular-nums"
                          data-mode={mode}
                          data-slot="export-size"
                        >
                          {sizeOf(mode)}
                        </span>
                      </>
                    }
                    icon={mode === "full" ? <ChartLineIcon /> : <ListIcon />}
                    title={t(modeLabels[mode])}
                  />
                </OptionCard>
              ))}
            </OptionCards>
            <Alert data-slot="export-secrets" variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>{t("setting_export_secrets_title")}</AlertTitle>
              <AlertDescription>{t("setting_export_secrets")}</AlertDescription>
            </Alert>
            <div className="flex flex-wrap items-center gap-3">
              <Button data-slot="export-download" type="submit">
                {t("setting_export_download")}
              </Button>
              <Token>{exportFileName}</Token>
            </div>
            {refused ? (
              <FieldError data-slot="export-refused">
                {t(exportRefusals[refused])}
                {refused === "unreadable" && record ? (
                  <>
                    {" "}
                    <Token>{record}</Token>
                  </>
                ) : null}
              </FieldError>
            ) : null}
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

const importRefusals: Readonly<
  Record<ImportRefusal | "too_large" | "no_file", MessageId>
> = {
  invalid: "setting_import_invalid",
  line_too_large: "setting_import_line_too_large",
  no_file: "setting_import_no_file",
  not_empty: "setting_import_not_empty",
  too_large: "setting_import_too_large",
  unavailable: "setting_export_unavailable",
  version: "setting_import_version",
};

type ImportState =
  | { readonly kind: "idle" }
  | { readonly kind: "importing" }
  | { readonly kind: "done"; readonly answer: ImportAnswer }
  | { readonly kind: "failed"; readonly reason: "too_large" | "no_file" };

/** What the upload's answer says, or why it has none. */
async function upload(file: File): Promise<ImportState> {
  const response = await fetch(importPath, {
    body: file,
    headers: { "content-type": "application/zstd" },
    method: "POST",
  });
  if (response.status === 401) {
    window.location.assign("/sign-in");
    return { kind: "importing" };
  }
  if (response.status === 413) {
    return { kind: "failed", reason: "too_large" };
  }
  const answer = importAnswerSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  return answer.success
    ? { answer: answer.data, kind: "done" }
    : { answer: { ok: false, reason: "unavailable" }, kind: "done" };
}

/** The answer line's state for the browser tests: the kind, or for an answer its refusal or "ok". */
function stateOf(state: ImportState): string {
  if (state.kind === "failed") {
    return state.reason;
  }
  if (state.kind !== "done") {
    return state.kind;
  }
  return state.answer.ok ? "ok" : state.answer.reason;
}

export function ImportCard(): ReactNode {
  const { locale, t } = useMessages();
  const [state, setState] = useState<ImportState>({ kind: "idle" });
  const picker = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<string>();
  const choose = useCallback(() => picker.current?.click(), []);
  const onFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setChosen(event.currentTarget.files?.[0]?.name);
  }, []);
  const onSubmit = useCallback((event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("file");
    if (!(file instanceof File) || file.size === 0) {
      setState({ kind: "failed", reason: "no_file" });
      return;
    }
    setState({ kind: "importing" });
    upload(file)
      .then(setState)
      .catch(() =>
        setState({
          answer: { ok: false, reason: "unavailable" },
          kind: "done",
        })
      );
  }, []);
  const answer = state.kind === "done" ? state.answer : undefined;
  return (
    <Card data-slot="import-card">
      <CardHeader divided>
        <CardTitle>{t("setting_import")}</CardTitle>
        <CardDescription>{t("setting_import_lead")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" noValidate onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="import-file">
                {t("setting_import_file")}
              </FieldLabel>
              {/* The browser's own picker words itself in the browser's language; this one follows the install's. */}
              <div className="flex flex-wrap items-center gap-3">
                <input
                  accept=".zst,application/zstd"
                  className="hidden"
                  name="file"
                  onChange={onFile}
                  ref={picker}
                  type="file"
                />
                <Button
                  id="import-file"
                  onClick={choose}
                  type="button"
                  variant="outline"
                >
                  {t("setting_import_choose")}
                </Button>
                {chosen ? (
                  <Token className="min-w-0 truncate">{chosen}</Token>
                ) : (
                  <span className="text-muted-foreground text-sm">
                    {t("setting_import_none")}
                  </span>
                )}
              </div>
              <FieldDescription>{t("setting_import_hint")}</FieldDescription>
            </Field>
            <div className="flex flex-col items-start gap-3">
              <Button
                data-slot="import-submit"
                disabled={state.kind === "importing"}
                type="submit"
              >
                {state.kind === "importing"
                  ? t("setting_importing")
                  : t("setting_import_submit")}
              </Button>
              <output
                aria-live="polite"
                data-slot="import-answer"
                data-state={stateOf(state)}
              >
                {answer?.ok ? (
                  <span className="text-xs">
                    {t("setting_import_done", {
                      monitors: formatNumber(locale, answer.monitors),
                      pages: formatNumber(locale, answer.pages),
                      records: formatNumber(locale, answer.records),
                    })}
                  </span>
                ) : null}
                {answer && !answer.ok ? (
                  <FieldError>
                    {t(importRefusals[answer.reason])}
                    {answer.line === undefined
                      ? null
                      : ` ${t("setting_import_line", { line: formatNumber(locale, answer.line) })}`}
                  </FieldError>
                ) : null}
                {state.kind === "failed" ? (
                  <FieldError>{t(importRefusals[state.reason])}</FieldError>
                ) : null}
              </output>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
