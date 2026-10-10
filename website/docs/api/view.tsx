/**
 * The API reference's entries, drawn from openApiDocument() at build
 * time and again at hydration, so a page shows what /api/openapi.json says.
 * Imported by the reference pages' MDX themselves, so only they carry the
 * document's schemas.
 */
import { CodeBlock, Pre } from "@fumadocs/base-ui/components/codeblock";
import { useI18n } from "@fumadocs/base-ui/contexts/i18n";
import { Fragment, type ReactNode } from "react";
import { openApiDocument } from "@/shared/api/openapi.ts";
import { type ApiLabels, labelsFor } from "./labels.ts";
import {
  type ApiBody,
  type ApiParameter,
  type ApiResponse,
  bodyOutline,
  operationsAt,
  schemaOutline,
  textSpans,
  webhookGroupOf,
} from "./reference.ts";

const doc = openApiDocument();

/** Every operation at `path` in the OpenAPI document; a path the document lacks fails the build. */
export function ApiOperation({ path }: { readonly path: string }): ReactNode {
  const labels = labelsFor(useI18n().locale);
  const operations = operationsAt(doc, path);
  if (operations.length === 0) {
    throw new Error(`the OpenAPI document has no path ${path}`);
  }
  return operations.map((op) => (
    <section className="my-6" key={op.methods.join()}>
      <Endpoint
        lines={op.paths.map((p) => ({ methods: op.methods, target: p }))}
      />
      <Text text={op.summary} />
      {op.description ? <Text text={op.description} /> : null}
      <Parameters labels={labels} parameters={op.parameters} />
      <Bodies
        bodies={op.requestBodies}
        label={labels.requestBody}
        labels={labels}
      />
      <Responses labels={labels} responses={op.responses} />
    </section>
  ));
}

/** The webhook `name` with every other one sending the same body; a name the document lacks fails the build. */
export function ApiWebhook({ name }: { readonly name: string }): ReactNode {
  const labels = labelsFor(useI18n().locale);
  const group = webhookGroupOf(doc, name);
  if (!group) {
    throw new Error(`the OpenAPI document has no webhook ${name}`);
  }
  const [only] = group.webhooks;
  return (
    <section className="my-6">
      <Endpoint
        lines={group.webhooks.map((w) => ({
          methods: [group.method],
          target: w.name,
        }))}
      />
      {only && group.webhooks.length === 1 ? (
        <>
          <Text text={only.summary} />
          {only.description ? <Text text={only.description} /> : null}
        </>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{labels.event}</th>
              <th>{labels.whenAndWhat}</th>
            </tr>
          </thead>
          <tbody>
            {group.webhooks.map((w) => (
              <tr key={w.name}>
                <td>
                  <code>{w.name}</code>
                </td>
                <td>
                  <bdi>
                    <Spans text={w.description ?? w.summary} />
                  </bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Parameters labels={labels} parameters={group.parameters} />
      <Bodies
        bodies={group.requestBodies}
        label={labels.body}
        labels={labels}
      />
      <Responses labels={labels} responses={group.responses} />
    </section>
  );
}

/** Methods and their path or webhook name, as machine tokens: left to right in every language. */
function Endpoint({
  lines,
}: {
  readonly lines: readonly {
    readonly methods: readonly string[];
    readonly target: string;
  }[];
}): ReactNode {
  return (
    <div
      className="not-prose flex flex-col gap-1 rounded-xl border bg-fd-card px-4 py-3 font-mono text-sm"
      dir="ltr"
    >
      {lines.map(({ methods, target }) => (
        <div className="flex flex-wrap items-baseline gap-x-3" key={target}>
          <span className="font-semibold text-fd-primary">
            {methods.map((m) => m.toUpperCase()).join(" ")}
          </span>
          <span className="break-all">{target}</span>
        </div>
      ))}
    </div>
  );
}

function Spans({ text }: { readonly text: string }): ReactNode {
  return textSpans(text).map((span, i) =>
    span.code ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the spans of one fixed text never reorder
      <code key={i}>{span.text}</code>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the spans of one fixed text never reorder
      <Fragment key={i}>{span.text}</Fragment>
    )
  );
}

/** The document's own sentence: English, so it reads left to right inside an Arabic page. */
function Text({ text }: { readonly text: string }): ReactNode {
  return (
    <p dir="auto">
      <Spans text={text} />
    </p>
  );
}

function Label({ children }: { readonly children: string }): ReactNode {
  return (
    <p>
      <strong>{children}</strong>
    </p>
  );
}

function Parameters({
  labels,
  parameters,
}: {
  readonly labels: ApiLabels;
  readonly parameters: readonly ApiParameter[];
}): ReactNode {
  if (parameters.length === 0) {
    return null;
  }
  const described = parameters.some((p) => p.description);
  return (
    <>
      <Label>
        {parameters.every((p) => p.location === "header")
          ? labels.headers
          : labels.parameters}
      </Label>
      <table>
        <thead>
          <tr>
            <th>{labels.name}</th>
            <th>{labels.in}</th>
            <th>{labels.type}</th>
            {described ? <th>{labels.description}</th> : null}
          </tr>
        </thead>
        <tbody>
          {parameters.map((p) => (
            <tr key={`${p.location}:${p.name}`}>
              <td>
                <code className="whitespace-nowrap">{p.name}</code>
                {p.required ? null : ` (${labels.optional})`}
              </td>
              <td>{labels.locations[p.location] ?? p.location}</td>
              <td>
                <code>{schemaOutline(p.schema)}</code>
                {typeof p.schema.pattern === "string" ? (
                  <>
                    {` ${labels.matching} `}
                    <code>{p.schema.pattern}</code>
                  </>
                ) : null}
              </td>
              {described ? (
                <td>
                  {p.description ? (
                    <bdi>
                      <Spans text={p.description} />
                    </bdi>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Bodies whose outline spans lines, each in a code block titled with its media type. */
function LongBodies({
  bodies,
  label,
}: {
  readonly bodies: readonly ApiBody[];
  readonly label?: string;
}): ReactNode {
  return bodies.map((body) => {
    const outline = bodyOutline(body);
    if (!outline?.includes("\n")) {
      return null;
    }
    return (
      <CodeBlock
        key={body.mediaType}
        title={label ? `${label}: ${body.mediaType}` : body.mediaType}
      >
        <Pre>
          <code>
            {outline.split("\n").map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one fixed outline never reorder
              <Fragment key={i}>
                {i > 0 ? "\n" : null}
                <span className="line">{line}</span>
              </Fragment>
            ))}
          </code>
        </Pre>
      </CodeBlock>
    );
  });
}

/** Bodies whose outline fits one line, or that have none, as media types in running text. */
function ShortBodies({
  bodies,
  labels,
  lead,
}: {
  readonly bodies: readonly ApiBody[];
  readonly labels: ApiLabels;
  readonly lead: string;
}): ReactNode {
  const short = bodies.filter((b) => !bodyOutline(b)?.includes("\n"));
  if (short.length === 0) {
    return null;
  }
  return (
    <>
      {lead}
      {short.map((body, i) => {
        const outline = bodyOutline(body);
        return (
          <Fragment key={body.mediaType}>
            {i > 0 ? labels.comma : null}
            <code>{body.mediaType}</code>
            {outline ? (
              <>
                {" "}
                <code>{outline}</code>
              </>
            ) : null}
          </Fragment>
        );
      })}
      {lead ? "." : null}
    </>
  );
}

function Bodies({
  bodies,
  label,
  labels,
}: {
  readonly bodies: readonly ApiBody[];
  readonly label: string;
  readonly labels: ApiLabels;
}): ReactNode {
  if (bodies.length === 0) {
    return null;
  }
  return (
    <>
      <Label>{label}</Label>
      {bodies.some((b) => !bodyOutline(b)?.includes("\n")) ? (
        <p>
          <ShortBodies bodies={bodies} labels={labels} lead="" />
        </p>
      ) : null}
      <LongBodies bodies={bodies} />
    </>
  );
}

/** Each status in a table; a body too long for a cell follows the table as a code block. */
function Responses({
  labels,
  responses,
}: {
  readonly labels: ApiLabels;
  readonly responses: readonly ApiResponse[];
}): ReactNode {
  return (
    <>
      <Label>{labels.responses}</Label>
      <table>
        <thead>
          <tr>
            <th>{labels.status}</th>
            <th>{labels.answer}</th>
          </tr>
        </thead>
        <tbody>
          {responses.map((r) => (
            <tr key={r.status}>
              <td>
                <code>{r.status}</code>
              </td>
              <td>
                <bdi>
                  <Spans text={r.description} />
                </bdi>
                {r.headers.length > 0 ? (
                  <>
                    {` ${labels.headers}: `}
                    {r.headers.map((h, i) => (
                      <Fragment key={h}>
                        {i > 0 ? labels.comma : null}
                        <code>{h}</code>
                      </Fragment>
                    ))}
                    .
                  </>
                ) : null}
                <ShortBodies
                  bodies={r.bodies}
                  labels={labels}
                  lead={` ${labels.body}: `}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {responses.map((r) => (
        <LongBodies
          bodies={r.bodies}
          key={r.status}
          label={labels.statusBody(r.status).replaceAll("`", "")}
        />
      ))}
    </>
  );
}
