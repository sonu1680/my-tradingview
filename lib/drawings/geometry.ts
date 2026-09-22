/**
 * Pure geometry for the chart drawing tools.
 *
 * Two coordinate spaces live here and they never mix:
 *
 *  - *Screen space* (`Pt`, CSS pixels): everything that hit-tests or lays out
 *    handles works on a `Projected`, i.e. on points the caller has already
 *    converted with the chart's own time/price scales.
 *  - *Chart space* (`Anchor`, unix seconds + price): everything that edits a
 *    drawing works on absolute (time, price), so the result is timeframe- and
 *    zoom-independent.
 *
 * This module imports nothing but the type contract. No canvas, no React, no
 * `lightweight-charts`.
 *
 * ---------------------------------------------------------------------------
 * HANDLE ORDER (the renderer and the interaction layer both index into this)
 * ---------------------------------------------------------------------------
 *  trendline : [a, b]
 *  hline     : []                 - no handles; the whole line is the body.
 *  vline     : []                 - likewise; the transpose of hline.
 *  rect      : [a, b]             - the two opposite corners, as stored.
 *  fib       : [a, b]             - a is the 0 level, b is the 1 level.
 *  position  : [entry, stop, target, leftEdge, rightEdge]
 *
 * Projection convention for `position`: the caller projects `entry` at the
 * LEFT edge (x of `time`) and `stop`/`target` at the RIGHT edge (x of
 * `endTime`). Hit-testing only relies on the horizontal span being
 * min..max over the point xs, so it stays correct if a caller projects
 * all three at the same x - it just loses the horizontal extent.
 *
 * The last two are the WIDTH handles, at the vertical middle of the box:
 * `leftEdge` drags `time`, `rightEdge` drags `endTime`. They are listed after
 * the price handles on purpose - `handleIndexAt` lets earlier handles win a
 * tie, so grabbing near a corner still moves the level, which is the more
 * common intent.
 */

import {
  DEFAULT_LOTS,
  FIB_RATIOS,
  HANDLE_SIZE,
  HIT_TOLERANCE,
  PIP_SIZE,
  XAUUSD_CONTRACT_SIZE,
  type Anchor,
  type Draft,
  type Drawing,
  type DrawingStyle,
  type Hit,
  type PositionDrawing,
  type PositionMetrics,
  type Projected,
  type Pt,
} from './types';

/**
 * Horizontal span, in seconds, given to a position whose two clicks landed on
 * the same bar. Without it the band would be zero-width and invisible; the
 * user drags it to the width they want. One hour matches the default chart
 * timeframe and reads as "a handful of bars" on most others.
 */
export const NOMINAL_POSITION_WIDTH_SECONDS = 3600;

/**
 * Narrowest a position may be dragged, in seconds.
 *
 * Without a floor, dragging one edge past the other collapses the box to zero
 * width - invisible, and with both edge handles stacked on top of each other
 * there is then no way to drag it back open.
 */
export const MIN_POSITION_WIDTH_SECONDS = 60;

/* ---------- small helpers ---------- */

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Chebyshev radius at which a square handle is considered grabbed. */
const handleRadius = (tolerance: number): number =>
  Math.max(HANDLE_SIZE / 2, tolerance);

const onHandle = (p: Pt, h: Pt, tolerance: number): boolean => {
  const r = handleRadius(tolerance);
  return Math.abs(p.x - h.x) <= r && Math.abs(p.y - h.y) <= r;
};

/** First handle under `p`, or -1. Earlier handles win ties. */
function handleIndexAt(handles: Pt[], p: Pt, tolerance: number): number {
  for (let i = 0; i < handles.length; i += 1) {
    if (onHandle(p, handles[i], tolerance)) return i;
  }
  return -1;
}

/* ---------- distance ---------- */

/** Perpendicular distance from p to segment ab (not the infinite line). */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  // Degenerate segment: fall back to the point distance.
  if (lenSq === 0) return dist(p, a);
  // Projection parameter, clamped so we measure to the segment, not the line.
  const t = clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq);
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/* ---------- handles ---------- */

/** Handle positions for a projected drawing, in the same order as `Projected.points`. */
export function handlePositions(proj: Projected): Pt[] {
  // An hline spans the whole chart width, so its x is meaningless and there is
  // nothing meaningful to place a handle on: the line itself is the grab area.
  // A vline is the same story transposed: full height, y meaningless.
  if (proj.drawing.kind === 'hline' || proj.drawing.kind === 'vline') return [];
  return proj.points.map((p) => ({ x: p.x, y: p.y }));
}

/* ---------- hit testing ---------- */

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const boxOf = (pts: Pt[]): Box => ({
  left: Math.min(...pts.map((p) => p.x)),
  right: Math.max(...pts.map((p) => p.x)),
  top: Math.min(...pts.map((p) => p.y)),
  bottom: Math.max(...pts.map((p) => p.y)),
});

const inBox = (p: Pt, b: Box): boolean =>
  p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;

/** Distance to the nearest of the four edges of the box. */
function distToBoxEdges(p: Pt, b: Box): number {
  const tl = { x: b.left, y: b.top };
  const tr = { x: b.right, y: b.top };
  const br = { x: b.right, y: b.bottom };
  const bl = { x: b.left, y: b.bottom };
  return Math.min(
    distToSegment(p, tl, tr),
    distToSegment(p, tr, br),
    distToSegment(p, br, bl),
    distToSegment(p, bl, tl),
  );
}

/**
 * Hit-test a projected drawing. Handles win over body.
 * Returns null when the point misses.
 */
export function hitTest(
  proj: Projected,
  p: Pt,
  tolerance: number = HIT_TOLERANCE,
): Hit | null {
  const { drawing, points } = proj;

  // Handles always win, whatever the kind.
  const hi = handleIndexAt(handlePositions(proj), p, tolerance);
  if (hi >= 0) return { type: 'handle', index: hi };

  switch (drawing.kind) {
    case 'trendline': {
      if (points.length < 2) return null;
      return distToSegment(p, points[0], points[1]) <= tolerance
        ? { type: 'body' }
        : null;
    }

    case 'hline': {
      if (points.length < 1) return null;
      // x is irrelevant: the line spans the chart.
      return Math.abs(p.y - points[0].y) <= tolerance ? { type: 'body' } : null;
    }

    case 'vline': {
      if (points.length < 1) return null;
      // y is irrelevant: the line spans the chart top to bottom.
      return Math.abs(p.x - points[0].x) <= tolerance ? { type: 'body' } : null;
    }

    case 'rect': {
      if (points.length < 2) return null;
      const box = boxOf(points);
      // The fill is transparent, so the interior must still be grabbable.
      if (inBox(p, box)) return { type: 'body' };
      return distToBoxEdges(p, box) <= tolerance ? { type: 'body' } : null;
    }

    case 'fib': {
      if (points.length < 2) return null;
      const [a, b] = points;
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      for (const ratio of FIB_RATIOS) {
        const y = a.y + ratio * (b.y - a.y);
        const d = distToSegment(p, { x: left, y }, { x: right, y });
        if (d <= tolerance) return { type: 'body' };
      }
      return null;
    }

    case 'position': {
      if (points.length < 3) return null;
      const box = boxOf(points);
      const withinX = p.x >= box.left - tolerance && p.x <= box.right + tolerance;
      if (!withinX) return null;
      // The entry/stop/target lines are the handles: grabbing anywhere along
      // one drags that band, which is what TradingView does.
      for (let i = 0; i < 3; i += 1) {
        if (Math.abs(p.y - points[i].y) <= tolerance) {
          return { type: 'handle', index: i };
        }
      }
      return inBox(p, box) ? { type: 'body' } : null;
    }
  }
}

/* ---------- fib ---------- */

/** Fib level prices from a (ratio 0) to b (ratio 1), in FIB_RATIOS order. */
export function fibLevels(a: Anchor, b: Anchor): Array<{ ratio: number; price: number }> {
  const span = b.price - a.price;
  // Note the sign is preserved: a descending a -> b produces descending
  // levels rather than silently flipping to ascending.
  return FIB_RATIOS.map((ratio) => ({ ratio, price: a.price + ratio * span }));
}

/* ---------- position metrics ---------- */

/** Risk/reward metrics for a position drawing. */
export function positionMetrics(pos: PositionDrawing): PositionMetrics {
  const riskPrice = Math.abs(pos.entry - pos.stop);
  const rewardPrice = Math.abs(pos.target - pos.entry);
  const perPrice = pos.lots * XAUUSD_CONTRACT_SIZE;

  const invalid =
    pos.side === 'long'
      ? !(pos.stop < pos.entry && pos.target > pos.entry)
      : !(pos.stop > pos.entry && pos.target < pos.entry);

  return {
    riskPrice,
    rewardPrice,
    riskPips: riskPrice / PIP_SIZE,
    rewardPips: rewardPrice / PIP_SIZE,
    rr: riskPrice === 0 ? null : rewardPrice / riskPrice,
    riskUsd: riskPrice * perPrice,
    rewardUsd: rewardPrice * perPrice,
    invalid,
  };
}

/* ---------- editing (always returns new objects) ---------- */

const shift = (a: Anchor, dt: number, dp: number): Anchor => ({
  time: a.time + dt,
  price: a.price + dp,
});

/** Apply a drag to a drawing, returning a NEW drawing (never mutate). */
export function moveDrawing(d: Drawing, deltaTime: number, deltaPrice: number): Drawing {
  switch (d.kind) {
    case 'trendline':
    case 'rect':
    case 'fib':
      return { ...d, a: shift(d.a, deltaTime, deltaPrice), b: shift(d.b, deltaTime, deltaPrice) };
    case 'hline':
      // Spans the full width, so a horizontal drag is meaningless.
      return { ...d, price: d.price + deltaPrice };
    case 'vline':
      // Spans the full height, so a vertical drag is meaningless.
      return { ...d, time: d.time + deltaTime };
    case 'position':
      return {
        ...d,
        time: d.time + deltaTime,
        endTime: d.endTime + deltaTime,
        entry: d.entry + deltaPrice,
        stop: d.stop + deltaPrice,
        target: d.target + deltaPrice,
      };
  }
}

export function moveHandle(d: Drawing, handleIndex: number, to: Anchor): Drawing {
  const anchor: Anchor = { time: to.time, price: to.price };

  switch (d.kind) {
    case 'trendline':
    case 'rect':
    case 'fib':
      if (handleIndex === 0) return { ...d, a: anchor };
      if (handleIndex === 1) return { ...d, b: anchor };
      return d;

    case 'hline':
      // No handles are drawn, but index 0 is accepted as "the line".
      return handleIndex === 0 ? { ...d, price: to.price } : d;

    case 'vline':
      // Same convention as hline, transposed: index 0 drags the line in time.
      return handleIndex === 0 ? { ...d, time: to.time } : d;

    case 'position': {
      if (handleIndex === 0) {
        // Dragging entry carries stop and target with it, so the setup keeps
        // its shape (and its R:R). The span keeps its width too.
        const dp = to.price - d.entry;
        const dt = to.time - d.time;
        return {
          ...d,
          time: d.time + dt,
          endTime: d.endTime + dt,
          entry: to.price,
          stop: d.stop + dp,
          target: d.target + dp,
        };
      }
      if (handleIndex === 1) return { ...d, stop: to.price };
      if (handleIndex === 2) return { ...d, target: to.price };
      // Width. Each edge is clamped against the other so the box keeps a
      // grabbable span; the prices are untouched, so R:R never changes when
      // the user is only adjusting how long the setup is meant to run.
      if (handleIndex === 3) {
        return { ...d, time: Math.min(to.time, d.endTime - MIN_POSITION_WIDTH_SECONDS) };
      }
      if (handleIndex === 4) {
        return { ...d, endTime: Math.max(to.time, d.time + MIN_POSITION_WIDTH_SECONDS) };
      }
      return d;
    }
  }
}

/* ---------- draft -> drawing ---------- */

/** Build a finished drawing from a completed Draft. Returns null if the draft is incomplete. */
export function drawingFromDraft(
  draft: Draft,
  id: string,
  style: DrawingStyle,
): Drawing | null {
  const pts = draft.points;
  const base = { id, style: { ...style }, createdAt: Date.now() };

  if (draft.tool === 'hline') {
    if (pts.length < 1) return null;
    return { ...base, kind: 'hline', price: pts[0].price };
  }

  if (draft.tool === 'vline') {
    if (pts.length < 1) return null;
    return { ...base, kind: 'vline', time: pts[0].time };
  }

  if (pts.length < 2) return null;
  const a: Anchor = { time: pts[0].time, price: pts[0].price };
  const b: Anchor = { time: pts[1].time, price: pts[1].price };

  switch (draft.tool) {
    case 'trendline':
      return { ...base, kind: 'trendline', a, b };
    case 'rect':
      return { ...base, kind: 'rect', a, b };
    case 'fib':
      return { ...base, kind: 'fib', a, b };
    case 'long':
    case 'short': {
      const side = draft.tool === 'long' ? 'long' : 'short';
      const entry = a.price;
      const stop = b.price;
      const risk = Math.abs(entry - stop);
      // A sensible default 1:2 setup the user then drags.
      const target = side === 'long' ? entry + 2 * risk : entry - 2 * risk;
      const time = Math.min(a.time, b.time);
      const rawEnd = Math.max(a.time, b.time);
      const endTime = rawEnd > time ? rawEnd : time + NOMINAL_POSITION_WIDTH_SECONDS;
      return { ...base, kind: 'position', side, time, endTime, entry, stop, target, lots: DEFAULT_LOTS };
    }
  }
}


/**
 * Blend between two bar coordinates by where `t` falls between their times.
 *
 * Interpolation MUST happen in coordinate space, not logical-index space:
 * lightweight-charts' `logicalToCoordinate()` only accepts INTEGER logical
 * indices and silently returns 0 for a fractional one (verified against
 * v5.2.1 — 1548 -> 1451.92 but 1548.5 -> 0). Feeding it a fractional index
 * collapses every off-bar drawing to x=0, which looks like all your drawings
 * piling up at the left edge after a timeframe switch.
 *
 * Returns `xa` when the two times coincide, so a degenerate pair cannot
 * produce NaN.
 */
export function lerpCoordinate(
  xa: number,
  xb: number,
  ta: number,
  tb: number,
  t: number,
): number {
  if (!Number.isFinite(xa) || !Number.isFinite(xb)) return Number.NaN;
  if (ta === tb) return xa;
  const fraction = (t - ta) / (tb - ta);
  const x = xa + fraction * (xb - xa);
  return Number.isFinite(x) ? x : xa;
}
