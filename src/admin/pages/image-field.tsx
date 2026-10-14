/**
 * One of a page's images, logo, favicon or cover: the stored image as the public page will fetch it, a button that
 * picks a file and uploads it at once, and remove. A file is not draft
 * text, so it saves on its own and the editor reads the page again.
 */
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import { formatUnit } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type PageImage,
  type PageImageKind,
  type PageImageRefusal,
  type PageImageResult,
  pageImageMaxBytes,
  pageImageUrl,
} from "@/shared/schemas/page.ts";
import { Button } from "@/shared/ui/button.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { imageRefusalWords } from "./page-words.ts";

const labels: Readonly<Record<PageImageKind, MessageId>> = {
  cover: "page_field_cover",
  favicon: "page_field_favicon",
  logo: "page_field_logo",
};

/** What the file picker offers; the server still decides by the file's bytes. */
const accepted: Readonly<Record<PageImageKind, string>> = {
  cover: "image/png,image/jpeg,image/webp,image/svg+xml",
  favicon:
    "image/x-icon,image/vnd.microsoft.icon,image/png,image/jpeg,image/webp,image/svg+xml",
  logo: "image/png,image/jpeg,image/webp,image/svg+xml",
};

export interface ImageActions {
  readonly remove: (
    kind: PageImageKind
  ) => Promise<PageImageResult | undefined>;
  readonly upload: (
    kind: PageImageKind,
    file: File
  ) => Promise<PageImageResult | undefined>;
}

type ImageState =
  | { readonly kind: "idle" | "pending" }
  | { readonly kind: "failed"; readonly reason: PageImageRefusal };

export function ImageField({
  actions,
  image,
  kind,
  onChanged,
  pageId,
}: {
  readonly actions: ImageActions;
  readonly image: PageImage | undefined;
  readonly kind: PageImageKind;
  readonly onChanged: () => void;
  readonly pageId: string;
}): ReactNode {
  const { locale, t } = useMessages();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ImageState>({ kind: "idle" });

  const settle = useCallback(
    (result: PageImageResult | undefined) => {
      if (result?.ok) {
        setState({ kind: "idle" });
        onChanged();
        return;
      }
      setState({
        kind: "failed",
        reason: result?.ok === false ? result.reason : "unavailable",
      });
    },
    [onChanged]
  );
  const choose = useCallback(() => input.current?.click(), []);
  const onFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) {
        return;
      }
      // Said here: a file past the request limit never reaches the server's own refusal.
      if (file.size > pageImageMaxBytes[kind]) {
        setState({ kind: "failed", reason: "too_large" });
        return;
      }
      setState({ kind: "pending" });
      settle(await actions.upload(kind, file).catch(() => undefined));
    },
    [actions, kind, settle]
  );
  const onRemove = useCallback(async () => {
    setState({ kind: "pending" });
    settle(await actions.remove(kind).catch(() => undefined));
  }, [actions, kind, settle]);

  const limit = pageImageMaxBytes[kind];
  const size =
    limit >= 1_048_576
      ? formatUnit(locale, limit / 1_048_576, "megabyte")
      : formatUnit(locale, limit / 1024, "kilobyte");
  return (
    <Field data-image={kind} data-slot="page-image">
      <FieldLabel>{t(labels[kind])}</FieldLabel>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-16 min-w-16 items-center justify-center rounded-lg border border-border bg-muted p-1">
          {image ? (
            <img
              alt=""
              className="h-auto max-h-14 w-auto max-w-40 object-contain"
              data-slot="page-image-preview"
              height={56}
              src={pageImageUrl(pageId, image)}
              width={160}
            />
          ) : (
            <span className="px-2 text-muted-foreground text-xs">
              {t("page_image_none")}
            </span>
          )}
        </div>
        <input
          accept={accepted[kind]}
          className="hidden"
          name={`image-${kind}`}
          onChange={onFile}
          ref={input}
          type="file"
        />
        <Button
          data-slot="choose-image"
          disabled={state.kind === "pending"}
          onClick={choose}
          type="button"
          variant="outline"
        >
          {state.kind === "pending"
            ? t("page_image_uploading")
            : t(image ? "page_image_replace" : "page_image_choose")}
        </Button>
        {image ? (
          <Button
            data-slot="remove-image"
            disabled={state.kind === "pending"}
            onClick={onRemove}
            type="button"
            variant="ghost"
          >
            {t("page_image_remove")}
          </Button>
        ) : null}
      </div>
      <FieldDescription>
        {t(
          kind === "favicon" ? "page_image_types_favicon" : "page_image_types",
          {
            size,
          }
        )}
      </FieldDescription>
      {kind === "cover" ? (
        <FieldDescription>{t("page_field_cover_hint")}</FieldDescription>
      ) : null}
      {state.kind === "failed" ? (
        <FieldError data-reason={state.reason}>
          {t(imageRefusalWords[state.reason])}
        </FieldError>
      ) : null}
    </Field>
  );
}
