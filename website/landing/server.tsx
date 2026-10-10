/**
 * What it needs to run: the memory line of the last benchmark drawing
 * itself under the limit, beside a hand-drawn figure of the one process and
 * its three parts, and the run's numbers as a row of figures.
 */
import type { ReactNode } from "react";
import type { Copy } from "~/copy.ts";
import { bench, dayMemory } from "./bench.ts";
import { Section, useSeen } from "./section.tsx";

const width = 600;
const height = 180;
/** The axis tops a little above the limit, so the limit line sits inside the chart. */
const top = 260;
const last = dayMemory.length - 1;
const x = (i: number) => (i / last) * width;
const y = (mb: number) => height - (mb / top) * height;
const path = dayMemory
  .map((mb, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(mb).toFixed(1)}`)
  .join(" ");

export function Server({ copy }: { readonly copy: Copy }): ReactNode {
  const s = copy.server;
  const [ref, seen] = useSeen();
  return (
    <Section backdrop="blueprint" id="server" lead={s.lead} title={s.title}>
      <div
        className="mt-16 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-14 gap-y-12 max-lg:grid-cols-1"
        ref={ref}
      >
        <figure>
          <div className="relative">
            <svg
              aria-label={s.chart.title}
              className="mirror block h-[260px] w-full border-line border-b max-md:h-[180px]"
              preserveAspectRatio="none"
              role="img"
              viewBox={`0 0 ${width} ${height}`}
            >
              <line
                className="stroke-down"
                strokeDasharray="4 4"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                x1="0"
                x2={width}
                y1={y(bench.limit)}
                y2={y(bench.limit)}
              />
              <path
                className="fill-teal-soft"
                d={`${path} L${width},${height} L0,${height} Z`}
                style={{ opacity: seen ? 1 : 0, transition: "opacity 1.2s" }}
              />
              <path
                className={`stroke-teal ${seen ? "unveil" : "invisible"}`}
                d={path}
                fill="none"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <span
              className="pointer-events-none absolute start-0 font-medium text-[13px] text-down-text"
              style={{
                top: `calc(${(y(bench.limit) / height) * 100}% - 1.6rem)`,
              }}
            >
              {s.chart.limit}
            </span>
          </div>
          <figcaption className="mt-4 max-w-[48em] text-[15px] text-strong">
            {s.chart.caption.replace(
              "{date}",
              new Intl.DateTimeFormat(
                copy.locale === "ar"
                  ? "ar-SA-u-ca-islamic-umalqura-nu-latn"
                  : "en-GB-u-ca-gregory",
                {
                  day: "numeric",
                  month: "long",
                  timeZone: "UTC",
                  year: "numeric",
                }
              ).format(bench.ranAt)
            )}
          </figcaption>
        </figure>
        <figure>
          <Process />
          <figcaption className="mt-4 text-center text-[15px] text-strong">
            {s.figure}
          </figcaption>
        </figure>
      </div>
      <dl className="mt-20 grid grid-cols-5 gap-x-8 max-sm:grid-cols-2 max-lg:grid-cols-3">
        {s.figures.map(([figure, unit, text]) => (
          <div
            className="flex flex-col-reverse justify-end gap-2 border-line border-t pt-4 pb-8"
            key={unit + figure}
          >
            <dt className="text-[14px] text-strong leading-[1.5]">{text}</dt>
            <dd className="font-medium text-[clamp(36px,3.6vw,48px)] tabular-nums leading-none tracking-[-0.03em]">
              {figure}
              <span className="ms-1.5 font-normal text-[15px] text-muted tracking-normal">
                {unit}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

const cos30 = Math.cos(Math.PI / 6);
const sin30 = 0.5;
/** One unit of the figure's space, in view-box pixels. */
const step = 26;

/** A point of the figure's space on the page: u and v run along the floor, w up, in isometric projection. */
function iso(u: number, v: number, w: number): readonly [number, number] {
  return [300 + (u - v) * step * cos30, 60 + (u + v) * step * sin30 - w * step];
}

/** Points of the figure's space as an SVG points list. */
function points(
  ...corners: readonly (readonly [number, number, number])[]
): string {
  return corners
    .map(([u, v, w]) =>
      iso(u, v, w)
        .map((n) => n.toFixed(1))
        .join(",")
    )
    .join(" ");
}

/** A box: its two faces toward the viewer, then its top. */
function Block({
  at: [u0, v0, w0],
  size: [du, dv, dw],
  face,
  sides,
}: {
  readonly at: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  /** The classes of the right face and the left face. */
  readonly sides: readonly [string, string];
  /** The class of the top face. */
  readonly face: string;
}): ReactNode {
  const [u1, v1, w1] = [u0 + du, v0 + dv, w0 + dw];
  return (
    <>
      <polygon
        className={sides[0]}
        points={points([u1, v0, w0], [u1, v1, w0], [u1, v1, w1], [u1, v0, w1])}
      />
      <polygon
        className={sides[1]}
        points={points([u0, v1, w0], [u1, v1, w0], [u1, v1, w1], [u0, v1, w1])}
      />
      <polygon
        className={face}
        points={points([u0, v0, w1], [u1, v0, w1], [u1, v1, w1], [u0, v1, w1])}
      />
    </>
  );
}

/** A 24-step icon laid flat on a top face centred at a point of the figure's space. */
function Flat({
  children,
  at: [u, v, w],
  scale,
}: {
  readonly at: readonly [number, number, number];
  readonly children: ReactNode;
  readonly scale: number;
}): ReactNode {
  const [px, py] = iso(u, v, w);
  const a = ((cos30 * step) / 24) * scale;
  const b = ((sin30 * step) / 24) * scale;
  return (
    <g
      transform={`matrix(${a.toFixed(3)} ${b.toFixed(3)} ${(-a).toFixed(3)} ${b.toFixed(3)} ${px.toFixed(1)} ${py.toFixed(1)}) translate(-12 -12)`}
    >
      {children}
    </g>
  );
}

/** The process's three parts: the scheduler, the notification queue and the database, each with its card on the floor and how high its cube floats. */
const parts = [
  {
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    lift: 3.2,
    u: 1,
    v: 1.3,
  },
  {
    icon: (
      <>
        <path d="M6 9a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
        <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
      </>
    ),
    lift: 4,
    u: 6.2,
    v: 2,
  },
  {
    icon: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14a8 3 0 0 0 16 0V5" />
        <path d="M4 12a8 3 0 0 0 16 0" />
      </>
    ),
    lift: 2.8,
    u: 2.4,
    v: 6.4,
  },
] as const;

/** The floor's dots, one at each whole point inside it. */
const dots = Array.from({ length: 81 }, (_, n) =>
  iso(1 + (n % 9), 1 + Math.floor(n / 9), 0)
);

/**
 * The one process, drawn by hand in isometric projection: a floor on one
 * core and 240 MB, the scheduler, the notification queue and the database
 * each a cube floating over its card on the floor, a line dropping from one
 * to the other. The cubes bob and a light runs down each line, unless the
 * visitor asks for less motion.
 */
function Process(): ReactNode {
  const glyph = {
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: 2.2,
  } as const;
  return (
    <svg
      aria-hidden="true"
      className="mx-auto block h-auto w-full max-w-[520px]"
      direction="ltr"
      strokeLinejoin="round"
      viewBox="62 -48 476 426"
    >
      <Block
        at={[0, 0, -0.45]}
        face="fill-surface stroke-line"
        sides={["fill-soft stroke-line", "fill-line-2 stroke-line"]}
        size={[10, 10, 0.45]}
      />
      {dots.map(([dx, dy]) => (
        <circle
          className="fill-line"
          cx={dx}
          cy={dy}
          key={`${dx},${dy}`}
          r="1.1"
        />
      ))}
      {parts.map(({ icon, u, v }) => (
        <g key={`card${u}`}>
          <Block
            at={[u, v, 0]}
            face="fill-surface stroke-line"
            sides={["fill-soft stroke-line", "fill-soft stroke-line"]}
            size={[2.6, 1.7, 0.28]}
          />
          <Flat at={[u + 0.75, v + 0.85, 0.28]} scale={0.75}>
            <g className="stroke-muted" {...glyph}>
              {icon}
            </g>
          </Flat>
          <line
            className="stroke-muted"
            opacity="0.6"
            strokeLinecap="round"
            strokeWidth="3"
            x1={iso(u + 1.4, v + 0.5, 0.28)[0]}
            x2={iso(u + 2.25, v + 0.5, 0.28)[0]}
            y1={iso(u + 1.4, v + 0.5, 0.28)[1]}
            y2={iso(u + 2.25, v + 0.5, 0.28)[1]}
          />
          <circle
            className="fill-up"
            cx={iso(u + 1.6, v + 1.25, 0.28)[0]}
            cy={iso(u + 1.6, v + 1.25, 0.28)[1]}
            r="2.6"
          />
        </g>
      ))}
      {/* back to front, so a nearer cube covers a farther one */}
      {parts
        .toSorted((a, b) => a.u + a.v - (b.u + b.v))
        .map(({ icon, lift, u, v }, n) => {
          const [cu, cv] = [u + 1.3, v + 0.85];
          // The line starts inside the cube, so it stays attached while the cube floats.
          const [px, high] = iso(cu, cv, lift + 0.6);
          const [, foot] = iso(cu, cv, 0.28);
          return (
            <g key={`cube${u}`}>
              <line
                className="stroke-teal"
                strokeWidth="1.6"
                x1={px}
                x2={px}
                y1={high}
                y2={foot}
              />
              <path
                className="pulse stroke-teal"
                d={`M${px},${high} L${px},${foot}`}
                pathLength="100"
                strokeLinecap="round"
                strokeWidth="3"
                style={{ "--i": n * 2 }}
              />
              <circle className="fill-teal" cx={px} cy={foot} r="3.2" />
              <g className="bob" style={{ "--i": n }}>
                <Block
                  at={[cu - 0.9, cv - 0.9, lift]}
                  face="fill-teal-soft stroke-teal"
                  sides={[
                    "fill-teal-soft stroke-teal",
                    "fill-teal-soft stroke-teal opacity-90",
                  ]}
                  size={[1.8, 1.8, 1.8]}
                />
                <Flat at={[cu, cv, lift + 1.8]} scale={1.05}>
                  <g className="stroke-teal-text" {...glyph}>
                    {icon}
                  </g>
                </Flat>
              </g>
            </g>
          );
        })}
      <text
        className="fill-muted"
        direction="ltr"
        fontFamily="IBM Plex Mono, monospace"
        fontSize="12"
        textAnchor="middle"
        x="300"
        y="368"
      >
        1 vCPU · 240 MB
      </text>
    </svg>
  );
}
