/**
 * A Docker monitor's target in the form: the daemon's endpoint, the
 * container's name, and the daemon's containers to choose it from. The
 * list is read on request from the endpoint the form holds; when it cannot
 * be read, the reason says why and the name is typed by hand.
 */
import { type MouseEvent, type ReactNode, useCallback, useState } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type ContainerChoice,
  type ContainerListResult,
  containerListSchema,
  dockerSocketPath,
} from "@/shared/schemas/monitor.ts";
import { reasonMessageId } from "@/shared/schemas/reason.ts";
import { Button } from "@/shared/ui/button.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { FailureDetail } from "./check-parts.tsx";
import { type SectionProps, TextField } from "./form-parts.tsx";

/** Lists the containers of the daemon at the endpoint; nothing when the session check redirected. */
export type ListContainers = (
  endpoint: string
) => Promise<ContainerListResult | undefined>;

type ListState =
  /** "unanswered": the server function itself failed, before any daemon was asked. */
  | { readonly kind: "idle" | "running" | "invalid" | "unanswered" }
  | {
      readonly kind: "done";
      /** The endpoint the list was read from; another one in the field hides it. */
      readonly endpoint: string;
      readonly result: ContainerListResult;
    };

export function DockerTarget({
  draft,
  errors,
  listContainers,
  onChoice,
  onField,
}: Pick<SectionProps, "draft" | "errors" | "onChoice" | "onField"> & {
  readonly listContainers: ListContainers;
}): ReactNode {
  const { t } = useMessages();
  const [listing, setListing] = useState<ListState>({ kind: "idle" });
  const { dockerEndpoint } = draft;
  const list = useCallback(() => {
    const parsed = containerListSchema.safeParse({ endpoint: dockerEndpoint });
    if (!parsed.success) {
      setListing({ kind: "invalid" });
      return;
    }
    setListing({ kind: "running" });
    const { endpoint } = parsed.data;
    listContainers(endpoint).then(
      (result) =>
        setListing(
          result ? { endpoint, kind: "done", result } : { kind: "idle" }
        ),
      () => setListing({ kind: "unanswered" })
    );
  }, [dockerEndpoint, listContainers]);
  const choose = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      onChoice("container", event.currentTarget.dataset.container ?? "");
    },
    [onChoice]
  );
  return (
    <>
      <TextField
        dir="ltr"
        errors={errors}
        hint={t("monitor_field_docker_endpoint_hint")}
        label={t("monitor_field_docker_endpoint")}
        name="dockerEndpoint"
        onField={onField}
        path="config.endpoint"
        placeholder={dockerSocketPath}
        value={dockerEndpoint}
        variant="token"
      />
      <TextField
        dir="ltr"
        errors={errors}
        hint={t("monitor_field_container_hint")}
        label={t("monitor_field_container")}
        name="container"
        onField={onField}
        path="config.container"
        placeholder="web"
        value={draft.container}
        variant="token"
      />
      <div className="flex flex-col gap-3" data-slot="container-list">
        <Button
          className="self-start"
          data-slot="list-containers"
          disabled={listing.kind === "running"}
          onClick={list}
          type="button"
          variant="outline"
        >
          {listing.kind === "running"
            ? t("monitor_containers_listing")
            : t("monitor_containers_list")}
        </Button>
        <Listed
          chosen={draft.container}
          // A list read from another daemon would name a container this one may not have.
          listing={
            listing.kind === "done" &&
            listing.endpoint !== dockerEndpoint.trim()
              ? { kind: "idle" }
              : listing
          }
          onChoose={choose}
        />
      </div>
    </>
  );
}

function Listed({
  chosen,
  listing,
  onChoose,
}: {
  readonly chosen: string;
  readonly listing: ListState;
  readonly onChoose: (event: MouseEvent<HTMLButtonElement>) => void;
}): ReactNode {
  const { t } = useMessages();
  if (listing.kind === "invalid") {
    return (
      <p className="text-destructive text-sm" role="alert">
        {t("monitor_error_docker_endpoint")}
      </p>
    );
  }
  if (listing.kind === "unanswered") {
    return (
      <p
        className="text-destructive text-sm"
        data-slot="containers-failed"
        role="alert"
      >
        {t("monitor_containers_failed")}
      </p>
    );
  }
  if (listing.kind !== "done") {
    return null;
  }
  const { result } = listing;
  if (!result.ok) {
    return (
      <div
        className="flex flex-col gap-2 text-sm"
        data-reason={result.reason}
        data-slot="containers-failed"
        role="alert"
      >
        <p className="text-destructive">{t("monitor_containers_failed")}</p>
        <p>{t(reasonMessageId(result.reason))}</p>
        <FailureDetail failure={result} />
      </div>
    );
  }
  if (result.containers.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("monitor_containers_empty")}
      </p>
    );
  }
  return (
    <ul
      aria-label={t("monitor_containers_choose")}
      className="flex max-h-72 flex-col divide-y divide-border overflow-auto rounded-lg border border-border"
      data-slot="container-choices"
    >
      {result.containers.map((container) => (
        <li key={container.name}>
          <ContainerRow
            chosen={container.name === chosen}
            container={container}
            onChoose={onChoose}
          />
        </li>
      ))}
    </ul>
  );
}

/** One container: its name first, then Docker's word for its state, then its image. */
function ContainerRow({
  chosen,
  container,
  onChoose,
}: {
  readonly chosen: boolean;
  readonly container: ContainerChoice;
  readonly onChoose: (event: MouseEvent<HTMLButtonElement>) => void;
}): ReactNode {
  return (
    <button
      aria-pressed={chosen}
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-start text-sm outline-none hover:bg-muted focus-visible:bg-muted aria-pressed:bg-muted"
      data-container={container.name}
      onClick={onChoose}
      type="button"
    >
      <bdi className="font-medium font-mono" dir="ltr">
        {container.name}
      </bdi>
      <Token
        className={
          container.state === "running"
            ? "bg-status-up-soft text-status-up-text"
            : undefined
        }
      >
        {container.state}
      </Token>
      <bdi
        className="min-w-0 truncate font-mono text-muted-foreground text-xs"
        dir="ltr"
      >
        {container.image}
      </bdi>
    </button>
  );
}
