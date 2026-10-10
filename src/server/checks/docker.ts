/**
 * The Docker check (CONTEXT.md "Container monitor"):
 * the daemon's Engine API, over a Unix socket or a URL, answers for
 * the container by its name, and the container is up when it runs and its
 * HEALTHCHECK, if it has one, has not called it unhealthy. One call is one
 * check with its retries and the degraded threshold over the time the API
 * call took. It does no I/O beyond the injected `requestDocker`, takes `now`
 * and `sleep` as parameters, and never throws. A Docker check has no status
 * code, reads no bytes and keeps no capture. The form's container list goes
 * through the same request.
 */
import { z } from "zod";
import { type CheckOutcome, errorMaxLength } from "@/shared/schemas/check.ts";
import type {
  ContainerListResult,
  DockerConfig,
  Monitor,
} from "@/shared/schemas/monitor.ts";
import {
  observedMaxLength,
  type ReasonParams,
} from "@/shared/schemas/reason.ts";
import { type Attempt, type AttemptIo, runAttempts } from "./attempts.ts";
import { reasonForDockerError } from "./errors.ts";

/** One GET to the daemon's Engine API, with no version prefix, so the daemon answers in its own. */
export interface DockerRequest {
  /** A Unix socket's path, or the API's http or https URL. */
  readonly endpoint: string;
  /** The API path and query: `/containers/web/json`. */
  readonly path: string;
  readonly timeoutMs: number;
}

/** The daemon's answer: its status and its body as JSON, or nothing when the body is not JSON. */
export interface DockerAnswer {
  readonly body: unknown;
  readonly status: number;
}

/** Answers the daemon's answer; rejects with the transport's error, or a `TimeoutError` past the timeout. */
export type RequestDocker = (request: DockerRequest) => Promise<DockerAnswer>;

/** The I/O a Docker check borrows; tests hand in fakes. */
export interface DockerIo extends AttemptIo {
  readonly requestDocker: RequestDocker;
}

/** What the Docker check needs of a monitor. */
export type DockerMonitor = Pick<
  Monitor,
  "id" | "timeoutMs" | "retries" | "degradedMs"
> & { readonly config: DockerConfig };

/** Runs one check of the monitor now: attempts until one succeeds or the retries are spent. */
export function runDockerCheck(
  monitor: DockerMonitor,
  io: DockerIo
): Promise<CheckOutcome> {
  return runAttempts(monitor, io, () => attemptOnce(monitor, io));
}

/** One answer from the daemon judged by the up rule, or the error the request met. */
async function attemptOnce(
  monitor: DockerMonitor,
  io: DockerIo
): Promise<Attempt> {
  const { config, timeoutMs } = monitor;
  const start = io.now();
  const elapsed = () => Math.min(io.now() - start, timeoutMs);
  try {
    const answer = await io.requestDocker({
      endpoint: config.endpoint,
      path: `/containers/${encodeURIComponent(config.container)}/json`,
      timeoutMs,
    });
    return { ...verdictOf(answer, config.container), responseMs: elapsed() };
  } catch (error) {
    return {
      ...reasonForDockerError(error, config.endpoint, timeoutMs),
      responseMs: elapsed(),
      succeeded: false,
    };
  }
}

/** What the check reads of `GET /containers/{name}/json`; Docker sends much more. */
const inspectSchema = z.object({
  Name: z.string(),
  State: z.object({
    Error: z.string().optional(),
    ExitCode: z.int().default(0),
    Health: z
      .object({
        Log: z.array(z.object({ Output: z.string() })).nullish(),
        Status: z.string(),
      })
      .nullish(),
    Status: z.string(),
  }),
});

type Verdict = Omit<Attempt, "responseMs">;

const up: Verdict = { params: { reason: "ok" }, reason: "ok", succeeded: true };

/** Down for the reason, with the raw text beside it when there is one. */
function down(params: ReasonParams, error?: string): Verdict {
  const text = error?.trim().slice(0, errorMaxLength);
  return {
    error: text === "" ? undefined : text,
    params,
    reason: params.reason,
    succeeded: false,
  };
}

/**
 * The up rule: up while the container runs and its
 * health check, if it has one, is healthy or has not given a first verdict;
 * down when it is unhealthy, paused, restarting, dead, stopped or unknown.
 * Docker matches an id prefix when no container has the name, so an answer
 * for another container is not found.
 */
function verdictOf(answer: DockerAnswer, name: string): Verdict {
  const message = messageOf(answer.body);
  // A proxy at the wrong path answers 404 too; only the daemon's own words mean the container is missing.
  if (answer.status === 404 && noSuchContainer.test(message ?? "")) {
    return down({ reason: "container_not_found" }, message);
  }
  if (answer.status !== 200) {
    return down(
      {
        expected: ["200"],
        observed: answer.status,
        reason: "unexpected_status",
      },
      message
    );
  }
  const parsed = inspectSchema.safeParse(answer.body);
  if (!parsed.success) {
    return down(
      { reason: "unknown" },
      "the Docker endpoint's answer is not a container"
    );
  }
  const { State } = parsed.data;
  const answered = parsed.data.Name.replace(leadingSlash, "");
  if (answered !== name) {
    return down(
      { reason: "container_not_found" },
      `no container is named ${name}; the daemon answered for ${answered}`
    );
  }
  switch (State.Status) {
    case "running":
      return State.Health?.Status === "unhealthy"
        ? down(
            { reason: "container_unhealthy" },
            State.Health.Log?.at(-1)?.Output
          )
        : up;
    case "paused":
      return down({ reason: "container_paused" });
    case "restarting":
      return down({ exitCode: State.ExitCode, reason: "container_restarting" });
    case "dead":
      return down({ reason: "container_dead" }, State.Error);
    default:
      return down(
        {
          exitCode: State.ExitCode,
          reason: "container_not_running",
          state: State.Status.slice(0, observedMaxLength),
        },
        State.Error
      );
  }
}

const leadingSlash = /^\//;
/** Docker's "No such container: web" and Podman's "...: no such container". */
const noSuchContainer = /no such container/i;

/** The text of Docker's `{"message": ...}` error body, when it sent one. */
function messageOf(body: unknown): string | undefined {
  const parsed = z.object({ message: z.string() }).safeParse(body);
  return parsed.success ? parsed.data.message : undefined;
}

/** How long the form's container list waits; under Bun's ten idle seconds, so the request needs no hold. */
export const containerListTimeoutMs = 5000;

/** What the list reads of `GET /containers/json`: each container's names, state and image. */
const listSchema = z.array(
  z.object({
    Image: z.string(),
    Names: z.array(z.string()).min(1),
    State: z.string(),
  })
);

/** The daemon's containers, stopped ones too, sorted by name; a failure is the reason a check would give. */
export async function listContainers(
  endpoint: string,
  requestDocker: RequestDocker,
  timeoutMs: number
): Promise<ContainerListResult> {
  let answer: DockerAnswer;
  try {
    answer = await requestDocker({
      endpoint,
      path: "/containers/json?all=true",
      timeoutMs,
    });
  } catch (error) {
    const {
      error: text,
      params,
      reason,
    } = reasonForDockerError(error, endpoint, timeoutMs);
    return { error: text, ok: false, params, reason };
  }
  const parsed = listSchema.safeParse(answer.body);
  if (answer.status !== 200 || !parsed.success) {
    const { error, params, reason } =
      answer.status === 200
        ? down(
            { reason: "unknown" },
            "the Docker endpoint's answer is not a list of containers"
          )
        : down(
            {
              expected: ["200"],
              observed: answer.status,
              reason: "unexpected_status",
            },
            messageOf(answer.body)
          );
    return { error, ok: false, params, reason };
  }
  const containers = parsed.data
    .map((each) => ({
      image: each.Image,
      // A legacy link adds `/other/alias`; the container's own name has one slash.
      name: (
        each.Names.find((name) => name.lastIndexOf("/") === 0) ??
        each.Names[0] ??
        ""
      ).replace(leadingSlash, ""),
      state: each.State,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { containers, ok: true };
}
