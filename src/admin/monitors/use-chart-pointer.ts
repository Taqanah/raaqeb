/**
 * What a pointer, a finger and the keyboard do on the response-time chart
 *. Hover, or a finger drag, picks the bucket nearest
 * it; the arrow keys walk the buckets. A mouse drag, a finger held still and
 * then dragged, or Shift with the arrow keys selects a span, which letting
 * go, or Enter, zooms into. Escape lets go of what is picked, then of the
 * selection, then of the zoom.
 */
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Direction } from "@/shared/i18n/locale.ts";
import type { ChartSpan, ResponseSeries } from "@/shared/schemas/detail.ts";
import { chartWidth, nearestBucket, spanBetween, xOf } from "./chart.ts";

/** The bucket picked, and whether a finger picked it. */
export interface Active {
  readonly index: number;
  readonly touch: boolean;
}

/** A selection drawn on the chart: its edges in the drawing's units and the span it names. */
export interface Selection {
  readonly left: number;
  readonly right: number;
  readonly span: ChartSpan;
}

export interface ChartPointer {
  readonly active: Active | undefined;
  readonly handlers: {
    readonly onBlur: () => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    readonly onPointerCancel: () => void;
    readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    readonly onPointerLeave: (event: PointerEvent<HTMLDivElement>) => void;
    readonly onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    readonly onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  };
  readonly selection: Selection | undefined;
}

export interface ZoomOptions {
  readonly onZoom: ((span: ChartSpan) => void) | undefined;
  readonly onZoomOut: (() => void) | undefined;
  readonly zoomed: boolean;
}

/** How long a finger rests before it selects instead of reading values. */
const holdMs = 450;
/** How far a finger may move during the hold, in pixels, before it is reading values. */
const slipPx = 10;
/** A drag narrower than this share of the width is a click, not a selection. */
const smallestDrag = chartWidth / 100;

/** Where the event falls across the drawing, in its units. */
function xOfEvent(event: PointerEvent<HTMLDivElement>): number {
  const box = event.currentTarget.getBoundingClientRect();
  const share = (event.clientX - box.left) / box.width;
  return Math.min(chartWidth, Math.max(0, share * chartWidth));
}

/** The bucket an arrow, Home or End moves to from `index`; the arrow toward now is the newer one. */
function keyTarget(
  key: string,
  direction: Direction,
  index: number | undefined,
  last: number
): number | undefined {
  const newer = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
  const older = direction === "rtl" ? "ArrowRight" : "ArrowLeft";
  if (key === newer) {
    return index === undefined ? last : Math.min(last, index + 1);
  }
  if (key === older) {
    return Math.max(0, (index ?? last + 1) - 1);
  }
  return { End: last, Home: 0 }[key];
}

export function useChartPointer(
  series: ResponseSeries,
  direction: Direction,
  { onZoom, onZoomOut, zoomed }: ZoomOptions
): ChartPointer {
  const [active, setActive] = useState<Active | undefined>();
  const [drag, setDrag] = useState<
    { readonly anchor: number; readonly edge: number } | undefined
  >();
  // The bucket a Shift+arrow selection started from.
  const [keyAnchor, setKeyAnchor] = useState<number | undefined>();
  const hold = useRef<
    | {
        readonly clientX: number;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined
  >(undefined);
  const last = series.buckets.length - 1;

  const cancelHold = useCallback(() => {
    clearTimeout(hold.current?.timer);
    hold.current = undefined;
  }, []);
  useEffect(() => cancelHold, [cancelHold]);

  const pick = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const index = nearestBucket(series, xOfEvent(event), direction);
      setActive(
        index === undefined
          ? undefined
          : { index, touch: event.pointerType !== "mouse" }
      );
    },
    [direction, series]
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const x = xOfEvent(event);
      if (event.pointerType === "mouse") {
        if (event.button === 0 && onZoom) {
          event.currentTarget.setPointerCapture(event.pointerId);
          setKeyAnchor(undefined);
          setDrag({ anchor: x, edge: x });
        }
        return;
      }
      pick(event);
      if (!onZoom) {
        return;
      }
      const target = event.currentTarget;
      const { pointerId } = event;
      cancelHold();
      hold.current = {
        clientX: event.clientX,
        timer: setTimeout(() => {
          hold.current = undefined;
          // The finger may have lifted as the timer fired; then there is nothing to hold.
          if (target.hasPointerCapture(pointerId)) {
            setActive(undefined);
            setDrag({ anchor: x, edge: x });
          }
        }, holdMs),
      };
      target.setPointerCapture(pointerId);
    },
    [cancelHold, onZoom, pick]
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        hold.current &&
        Math.abs(event.clientX - hold.current.clientX) > slipPx
      ) {
        cancelHold();
      }
      if (drag) {
        setDrag({ ...drag, edge: xOfEvent(event) });
        return;
      }
      pick(event);
    },
    [cancelHold, drag, pick]
  );

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      cancelHold();
      if (drag) {
        setDrag(undefined);
        if (Math.abs(drag.edge - drag.anchor) >= smallestDrag) {
          onZoom?.(spanBetween(drag.anchor, drag.edge, series, direction));
        }
        return;
      }
      // A lifted finger gives the figures row back to the range.
      if (event.pointerType !== "mouse") {
        setActive(undefined);
      }
    },
    [cancelHold, direction, drag, onZoom, series]
  );

  const onPointerCancel = useCallback(() => {
    cancelHold();
    setDrag(undefined);
    setActive(undefined);
  }, [cancelHold]);

  const onPointerLeave = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && !drag) {
        setActive(undefined);
      }
    },
    [drag]
  );

  const onBlur = useCallback(() => {
    setActive(undefined);
    setKeyAnchor(undefined);
  }, []);

  // Escape lets go of the Shift selection, then of the picked bucket, then of the zoom.
  const letGo = useCallback(() => {
    if (keyAnchor !== undefined) {
      setKeyAnchor(undefined);
    } else if (active) {
      setActive(undefined);
    } else if (zoomed) {
      onZoomOut?.();
    }
  }, [active, keyAnchor, onZoomOut, zoomed]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        letGo();
        return;
      }
      const selected = selectionOf(
        series,
        direction,
        undefined,
        keyAnchor,
        active
      );
      if (event.key === "Enter" && selected) {
        event.preventDefault();
        setKeyAnchor(undefined);
        onZoom?.(selected.span);
        return;
      }
      const next = keyTarget(event.key, direction, active?.index, last);
      if (next === undefined || last < 0) {
        return;
      }
      event.preventDefault();
      const shifted = event.shiftKey && onZoom !== undefined;
      setKeyAnchor(shifted ? (keyAnchor ?? active?.index ?? next) : undefined);
      setActive({ index: next, touch: false });
    },
    [active, direction, letGo, keyAnchor, last, onZoom, series]
  );

  return {
    active: drag ? undefined : active,
    handlers: {
      onBlur,
      onKeyDown,
      onPointerCancel,
      onPointerDown,
      onPointerLeave,
      onPointerMove,
      onPointerUp,
    },
    selection: selectionOf(series, direction, drag, keyAnchor, active),
  };
}

/** The selection a drag, or a Shift+arrow walk, draws; nothing while neither is under way. */
function selectionOf(
  series: ResponseSeries,
  direction: Direction,
  drag: { readonly anchor: number; readonly edge: number } | undefined,
  keyAnchor: number | undefined,
  active: Active | undefined
): Selection | undefined {
  if (drag) {
    return {
      left: Math.min(drag.anchor, drag.edge),
      right: Math.max(drag.anchor, drag.edge),
      span: spanBetween(drag.anchor, drag.edge, series, direction),
    };
  }
  if (keyAnchor === undefined || !active) {
    return;
  }
  const older = series.buckets[Math.min(keyAnchor, active.index)];
  const newer = series.buckets[Math.max(keyAnchor, active.index)];
  if (!(older && newer)) {
    return;
  }
  // Whole minutes, as a drag's span is.
  const span = {
    from: Math.floor(older.at / 60_000) * 60_000,
    to: Math.ceil((newer.at + series.bucketMs) / 60_000) * 60_000,
  };
  const edges = [
    xOf(span.from, series, direction),
    xOf(span.to, series, direction),
  ];
  return { left: Math.min(...edges), right: Math.max(...edges), span };
}
