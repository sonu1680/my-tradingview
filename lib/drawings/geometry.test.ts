import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOTS,
  DEFAULT_STYLE,
  FIB_RATIOS,
  HIT_TOLERANCE,
  PIP_SIZE,
  XAUUSD_CONTRACT_SIZE,
  type Draft,
  type FibDrawing,
  type HLineDrawing,
  type PositionDrawing,
  type Projected,
  type RectDrawing,
  type TrendlineDrawing,
  type VLineDrawing,
} from '@/lib/drawings/types';

import {
  NOMINAL_POSITION_WIDTH_SECONDS,
  distToSegment,
  drawingFromDraft,
  fibLevels,
  handlePositions,
  hitTest,
  lerpCoordinate,
  moveDrawing,
  MIN_POSITION_WIDTH_SECONDS,
  moveHandle,
  positionMetrics,
} from '@/lib/drawings/geometry';

/* ---------- fixtures ---------- */

const trendline: TrendlineDrawing = {
  id: 't1',
  kind: 'trendline',
  style: DEFAULT_STYLE,
  createdAt: 1,
  a: { time: 1000, price: 100 },
  b: { time: 2000, price: 110 },
};

const hline: HLineDrawing = {
  id: 'h1',
  kind: 'hline',
  style: DEFAULT_STYLE,
  createdAt: 1,
  price: 100,
};

const vline: VLineDrawing = {
  id: 'v1',
  kind: 'vline',
  style: DEFAULT_STYLE,
  createdAt: 1,
  time: 1500,
};

const rect: RectDrawing = {
  id: 'r1',
  kind: 'rect',
  style: DEFAULT_STYLE,
  createdAt: 1,
  a: { time: 1000, price: 110 },
  b: { time: 2000, price: 100 },
};

const fib: FibDrawing = {
  id: 'f1',
  kind: 'fib',
  style: DEFAULT_STYLE,
  createdAt: 1,
  a: { time: 1000, price: 100 },
  b: { time: 2000, price: 200 },
};

const long: PositionDrawing = {
  id: 'p1',
  kind: 'position',
  style: DEFAULT_STYLE,
  createdAt: 1,
  side: 'long',
  time: 1000,
  endTime: 2000,
  entry: 100,
  stop: 90,
  target: 120,
  lots: 1,
};

const proj = (d: Projected['drawing'], points: Projected['points']): Projected => ({
  drawing: d,
  points,
});

/* ---------- distToSegment ---------- */

describe('distToSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };

  it('measures the perpendicular distance for a point over the segment', () => {
    expect(distToSegment({ x: 50, y: 12 }, a, b)).toBeCloseTo(12);
  });

  it('clamps to endpoint a for a point beyond a', () => {
    // The classic bug: using the infinite line would report 3, not 5.
    expect(distToSegment({ x: -4, y: 3 }, a, b)).toBeCloseTo(5);
  });

  it('clamps to endpoint b for a point beyond b', () => {
    expect(distToSegment({ x: 104, y: -3 }, a, b)).toBeCloseTo(5);
  });

  it('handles a degenerate segment where a equals b', () => {
    expect(distToSegment({ x: 3, y: 4 }, a, { x: 0, y: 0 })).toBeCloseTo(5);
  });

  it('returns zero on the segment itself', () => {
    expect(distToSegment({ x: 25, y: 0 }, a, b)).toBe(0);
  });
});

/* ---------- handlePositions ---------- */

describe('handlePositions', () => {
  it('returns the projected points for two-anchor shapes', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ];
    expect(handlePositions(proj(trendline, pts))).toEqual(pts);
    expect(handlePositions(proj(rect, pts))).toEqual(pts);
    expect(handlePositions(proj(fib, pts))).toEqual(pts);
  });

  it('returns no handles for an hline (the whole line is the body)', () => {
    expect(handlePositions(proj(hline, [{ x: 0, y: 100 }]))).toEqual([]);
  });

  it('returns no handles for a vline (the whole line is the body)', () => {
    expect(handlePositions(proj(vline, [{ x: 100, y: 0 }]))).toEqual([]);
  });

  it('returns entry, stop, target for a position', () => {
    const pts = [
      { x: 10, y: 200 },
      { x: 210, y: 300 },
      { x: 210, y: 0 },
    ];
    expect(handlePositions(proj(long, pts))).toEqual(pts);
  });

  it('copies the points rather than aliasing them', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ];
    const out = handlePositions(proj(trendline, pts));
    expect(out).not.toBe(pts);
    expect(out[0]).not.toBe(pts[0]);
  });
});

/* ---------- hitTest ---------- */

describe('hitTest: trendline', () => {
  const p = proj(trendline, [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);

  it('hits the body just inside tolerance', () => {
    expect(hitTest(p, { x: 50, y: 5.5 })).toEqual({ type: 'body' });
  });

  it('misses just outside tolerance', () => {
    expect(hitTest(p, { x: 50, y: 6.5 })).toBeNull();
  });

  it('misses past the end of the segment', () => {
    expect(hitTest(p, { x: 200, y: 0 })).toBeNull();
  });

  it('prefers a handle over the body when both are under the cursor', () => {
    expect(hitTest(p, { x: 2, y: 2 })).toEqual({ type: 'handle', index: 0 });
    expect(hitTest(p, { x: 99, y: 1 })).toEqual({ type: 'handle', index: 1 });
  });
});

describe('hitTest: hline', () => {
  const p = proj(hline, [{ x: 0, y: 100 }]);

  it('hits anywhere along x within tolerance', () => {
    expect(hitTest(p, { x: 5000, y: 104.5 })).toEqual({ type: 'body' });
    expect(hitTest(p, { x: -5000, y: 95.5 })).toEqual({ type: 'body' });
  });

  it('misses just outside tolerance', () => {
    expect(hitTest(p, { x: 5000, y: 107 })).toBeNull();
  });
});

describe('hitTest: vline', () => {
  // The transpose of hline: projected at x = 100, y is meaningless.
  const p = proj(vline, [{ x: 100, y: 0 }]);

  it('hits anywhere along y within tolerance on x', () => {
    // |104.5 - 100| = 4.5 <= 6, and y is wildly off the projected point.
    expect(hitTest(p, { x: 104.5, y: 5000 })).toEqual({ type: 'body' });
    expect(hitTest(p, { x: 95.5, y: -5000 })).toEqual({ type: 'body' });
  });

  it('hits exactly at the tolerance boundary', () => {
    expect(hitTest(p, { x: 100 + HIT_TOLERANCE, y: 0 })).toEqual({ type: 'body' });
  });

  it('misses just outside tolerance', () => {
    // |107 - 100| = 7 > 6.
    expect(hitTest(p, { x: 107, y: 0 })).toBeNull();
    expect(hitTest(p, { x: 93, y: 0 })).toBeNull();
  });

  it('returns null when nothing was projected', () => {
    expect(hitTest(proj(vline, []), { x: 100, y: 0 })).toBeNull();
  });
});

describe('hitTest: rect', () => {
  const p = proj(rect, [
    { x: 10, y: 10 },
    { x: 110, y: 60 },
  ]);

  it('hits the interior as body (the fill is transparent but grabbable)', () => {
    expect(hitTest(p, { x: 60, y: 35 })).toEqual({ type: 'body' });
  });

  it('hits an edge from outside, just inside tolerance', () => {
    expect(hitTest(p, { x: 60, y: 64 })).toEqual({ type: 'body' });
  });

  it('misses just outside tolerance', () => {
    expect(hitTest(p, { x: 60, y: 68 })).toBeNull();
  });

  it('prefers the corner handles', () => {
    expect(hitTest(p, { x: 12, y: 12 })).toEqual({ type: 'handle', index: 0 });
    expect(hitTest(p, { x: 108, y: 58 })).toEqual({ type: 'handle', index: 1 });
  });
});

describe('hitTest: fib', () => {
  const p = proj(fib, [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
  ]);

  it('hits a level line just inside tolerance', () => {
    // The 0.5 level sits at y = 50.
    expect(hitTest(p, { x: 50, y: 55 })).toEqual({ type: 'body' });
  });

  it('misses in the gap between level lines', () => {
    expect(hitTest(p, { x: 50, y: 12 })).toBeNull();
  });

  it('misses outside the horizontal span', () => {
    expect(hitTest(p, { x: -50, y: 50 })).toBeNull();
  });

  it('prefers the anchor handles', () => {
    expect(hitTest(p, { x: 2, y: 2 })).toEqual({ type: 'handle', index: 0 });
    expect(hitTest(p, { x: 98, y: 98 })).toEqual({ type: 'handle', index: 1 });
  });
});

describe('hitTest: position', () => {
  // entry projected at the left edge, stop/target at the right edge.
  const p = proj(long, [
    { x: 10, y: 200 },
    { x: 210, y: 300 },
    { x: 210, y: 0 },
  ]);

  it('hits inside the band as body', () => {
    expect(hitTest(p, { x: 100, y: 150 })).toEqual({ type: 'body' });
  });

  it('treats the entry/stop/target lines as handles', () => {
    expect(hitTest(p, { x: 100, y: 203 })).toEqual({ type: 'handle', index: 0 });
    expect(hitTest(p, { x: 100, y: 297 })).toEqual({ type: 'handle', index: 1 });
    expect(hitTest(p, { x: 100, y: 4 })).toEqual({ type: 'handle', index: 2 });
  });

  it('misses outside the band', () => {
    expect(hitTest(p, { x: 400, y: 150 })).toBeNull();
    expect(hitTest(p, { x: 100, y: 312 })).toBeNull();
  });

  it('hits just inside the bottom edge tolerance', () => {
    expect(hitTest(p, { x: 100, y: 305 })).toEqual({ type: 'handle', index: 1 });
  });
});

describe('hitTest: tolerance override', () => {
  const p = proj(trendline, [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);

  it('honours a custom tolerance', () => {
    expect(hitTest(p, { x: 50, y: 20 }, 25)).toEqual({ type: 'body' });
    expect(hitTest(p, { x: 50, y: 20 }, 1)).toBeNull();
  });

  it('defaults to HIT_TOLERANCE', () => {
    expect(hitTest(p, { x: 50, y: HIT_TOLERANCE - 0.5 })).toEqual({ type: 'body' });
  });
});

/* ---------- fibLevels ---------- */

describe('fibLevels', () => {
  it('returns 7 levels in FIB_RATIOS order for an ascending a -> b', () => {
    const levels = fibLevels({ time: 0, price: 100 }, { time: 1, price: 200 });
    expect(levels).toHaveLength(7);
    expect(levels.map((l) => l.ratio)).toEqual([...FIB_RATIOS]);
    expect(levels[0].price).toBeCloseTo(100);
    expect(levels[6].price).toBeCloseTo(200);
    expect(levels[3].price).toBeCloseTo(150); // 0.5
    expect(levels[1].price).toBeCloseTo(123.6); // 0.236
    expect(levels[4].price).toBeCloseTo(161.8); // 0.618
  });

  it('does not silently flip a descending a -> b', () => {
    const levels = fibLevels({ time: 0, price: 200 }, { time: 1, price: 100 });
    expect(levels[0].price).toBeCloseTo(200);
    expect(levels[6].price).toBeCloseTo(100);
    expect(levels[3].price).toBeCloseTo(150);
    expect(levels[1].price).toBeCloseTo(176.4); // 200 - 0.236 * 100
  });

  it('collapses to a single price when a and b share a price', () => {
    const levels = fibLevels({ time: 0, price: 100 }, { time: 1, price: 100 });
    expect(levels.every((l) => l.price === 100)).toBe(true);
  });
});

/* ---------- positionMetrics ---------- */

describe('positionMetrics', () => {
  it('computes a valid long at 1.00 lot', () => {
    const m = positionMetrics({ ...long, lots: 1 });
    expect(m.riskPrice).toBeCloseTo(10);
    expect(m.rewardPrice).toBeCloseTo(20);
    expect(m.riskPips).toBeCloseTo(10 / PIP_SIZE);
    expect(m.rewardPips).toBeCloseTo(20 / PIP_SIZE);
    expect(m.rr).toBeCloseTo(2);
    // A $10 stop at 1.00 lot on XAUUSD = $1000.
    expect(m.riskUsd).toBeCloseTo(10 * 1 * XAUUSD_CONTRACT_SIZE);
    expect(m.riskUsd).toBeCloseTo(1000);
    expect(m.rewardUsd).toBeCloseTo(2000);
    expect(m.invalid).toBe(false);
  });

  it('scales the dollars with lots at the 0.01 default', () => {
    const m = positionMetrics({ ...long, lots: 0.01 });
    expect(m.riskUsd).toBeCloseTo(10);
    expect(m.rewardUsd).toBeCloseTo(20);
    expect(m.rr).toBeCloseTo(2);
  });

  it('computes a valid short', () => {
    const m = positionMetrics({
      ...long,
      side: 'short',
      entry: 100,
      stop: 105,
      target: 85,
      lots: 1,
    });
    expect(m.riskPrice).toBeCloseTo(5);
    expect(m.rewardPrice).toBeCloseTo(15);
    expect(m.rr).toBeCloseTo(3);
    expect(m.riskUsd).toBeCloseTo(500);
    expect(m.invalid).toBe(false);
  });

  it('returns rr === null at zero risk', () => {
    const m = positionMetrics({ ...long, stop: 100 });
    expect(m.riskPrice).toBe(0);
    expect(m.rr).toBeNull();
    expect(m.invalid).toBe(true); // stop == entry is not below entry
  });

  it('flags a long whose stop is above entry as invalid', () => {
    expect(positionMetrics({ ...long, stop: 110, target: 120 }).invalid).toBe(true);
  });

  it('flags a long whose target is below entry as invalid', () => {
    expect(positionMetrics({ ...long, stop: 90, target: 105 }).invalid).toBe(false);
    expect(positionMetrics({ ...long, stop: 90, target: 100 }).invalid).toBe(true);
    expect(positionMetrics({ ...long, stop: 90, target: 95 }).invalid).toBe(true);
  });

  it('flags a short whose stop is below entry as invalid', () => {
    expect(
      positionMetrics({ ...long, side: 'short', stop: 95, target: 80 }).invalid,
    ).toBe(true);
  });
});

/* ---------- moveDrawing ---------- */

describe('moveDrawing', () => {
  it('shifts both anchors of a trendline and never mutates', () => {
    const before = structuredClone(trendline);
    const out = moveDrawing(trendline, 500, 5);
    expect(out).not.toBe(trendline);
    expect(trendline).toEqual(before);
    if (out.kind !== 'trendline') throw new Error('kind changed');
    expect(out.a).toEqual({ time: 1500, price: 105 });
    expect(out.b).toEqual({ time: 2500, price: 115 });
  });

  it('ignores deltaTime for an hline', () => {
    const out = moveDrawing(hline, 9999, -3);
    if (out.kind !== 'hline') throw new Error('kind changed');
    expect(out.price).toBeCloseTo(97);
    expect(out).not.toHaveProperty('time');
  });

  it('shifts a vline by deltaTime only and never mutates', () => {
    const before = structuredClone(vline);
    const out = moveDrawing(vline, 500, -9999);
    expect(out).not.toBe(vline);
    expect(vline).toEqual(before);
    if (out.kind !== 'vline') throw new Error('kind changed');
    expect(out.time).toBe(2000);
    expect(out).not.toHaveProperty('price');
    expect(out.id).toBe(vline.id);
    expect(out.style).toEqual(vline.style);
  });

  it('shifts a vline backwards in time', () => {
    const out = moveDrawing(vline, -1500, 0);
    if (out.kind !== 'vline') throw new Error('kind changed');
    expect(out.time).toBe(0);
  });

  it('shifts a rect and a fib', () => {
    const r = moveDrawing(rect, -100, 1);
    if (r.kind !== 'rect') throw new Error('kind changed');
    expect(r.a).toEqual({ time: 900, price: 111 });
    expect(r.b).toEqual({ time: 1900, price: 101 });

    const f = moveDrawing(fib, 10, 10);
    if (f.kind !== 'fib') throw new Error('kind changed');
    expect(f.a).toEqual({ time: 1010, price: 110 });
    expect(f.b).toEqual({ time: 2010, price: 210 });
  });

  it('shifts every band and both times of a position', () => {
    const before = structuredClone(long);
    const out = moveDrawing(long, 250, -5);
    expect(long).toEqual(before);
    if (out.kind !== 'position') throw new Error('kind changed');
    expect(out.time).toBe(1250);
    expect(out.endTime).toBe(2250);
    expect(out.entry).toBeCloseTo(95);
    expect(out.stop).toBeCloseTo(85);
    expect(out.target).toBeCloseTo(115);
    expect(out.lots).toBe(long.lots);
    expect(out.id).toBe(long.id);
  });
});

/* ---------- moveHandle ---------- */

describe('moveHandle', () => {
  it('moves a single trendline anchor', () => {
    const out = moveHandle(trendline, 1, { time: 3000, price: 130 });
    if (out.kind !== 'trendline') throw new Error('kind changed');
    expect(out.a).toEqual(trendline.a);
    expect(out.b).toEqual({ time: 3000, price: 130 });
  });

  it('moves an hline by price only', () => {
    const out = moveHandle(hline, 0, { time: 9999, price: 123 });
    if (out.kind !== 'hline') throw new Error('kind changed');
    expect(out.price).toBe(123);
  });

  it('moves a vline by time only', () => {
    const out = moveHandle(vline, 0, { time: 3000, price: 9999 });
    if (out.kind !== 'vline') throw new Error('kind changed');
    expect(out.time).toBe(3000);
    expect(out).not.toHaveProperty('price');
    expect(out.id).toBe(vline.id);
  });

  it('returns a vline unchanged for an out-of-range index', () => {
    expect(moveHandle(vline, 1, { time: 0, price: 0 })).toEqual(vline);
    expect(moveHandle(vline, -1, { time: 0, price: 0 })).toEqual(vline);
  });

  it('never mutates a vline', () => {
    const before = structuredClone(vline);
    moveHandle(vline, 0, { time: 42, price: 42 });
    moveHandle(vline, 3, { time: 42, price: 42 });
    expect(vline).toEqual(before);
  });

  it('returns the drawing unchanged for an out-of-range index', () => {
    expect(moveHandle(trendline, 7, { time: 0, price: 0 })).toEqual(trendline);
    expect(moveHandle(long, -1, { time: 0, price: 0 })).toEqual(long);
  });

  it('carries stop and target when the entry handle is dragged', () => {
    const before = structuredClone(long);
    const out = moveHandle(long, 0, { time: 1200, price: 105 });
    expect(long).toEqual(before); // no mutation
    if (out.kind !== 'position') throw new Error('kind changed');
    expect(out.entry).toBeCloseTo(105);
    expect(out.stop).toBeCloseTo(95);
    expect(out.target).toBeCloseTo(125);
    // The span keeps its width, shifted by the horizontal drag.
    expect(out.time).toBe(1200);
    expect(out.endTime).toBe(2200);
  });

  it('moves only the stop band when the stop handle is dragged', () => {
    const out = moveHandle(long, 1, { time: 9999, price: 95 });
    if (out.kind !== 'position') throw new Error('kind changed');
    expect(out.entry).toBe(100);
    expect(out.target).toBe(120);
    expect(out.stop).toBe(95);
    expect(out.time).toBe(1000);
    expect(out.endTime).toBe(2000);
  });

  it('moves only the target band when the target handle is dragged', () => {
    const out = moveHandle(long, 2, { time: 9999, price: 140 });
    if (out.kind !== 'position') throw new Error('kind changed');
    expect(out.entry).toBe(100);
    expect(out.stop).toBe(90);
    expect(out.target).toBe(140);
  });

  /* ---- width handles: 3 = left edge, 4 = right edge ---- */

  it('drags the left edge in time without touching any price', () => {
    const out = moveHandle(long, 3, { time: 400, price: 9999 });
    if (out.kind !== 'position') throw new Error('kind changed');
    expect(out.time).toBe(400);
    expect(out.endTime).toBe(2000);
    expect(out.entry).toBe(100);
    expect(out.stop).toBe(90);
    expect(out.target).toBe(120);
  });

  it('drags the right edge in time without touching any price', () => {
    const out = moveHandle(long, 4, { time: 5000, price: 9999 });
    if (out.kind !== 'position') throw new Error('kind changed');
    expect(out.time).toBe(1000);
    expect(out.endTime).toBe(5000);
    expect(out.entry).toBe(100);
    expect(out.stop).toBe(90);
    expect(out.target).toBe(120);
  });

  it('keeps the R:R identical when only the width changes', () => {
    const before = positionMetrics(long);
    const wider = moveHandle(long, 4, { time: 9000, price: 0 });
    if (wider.kind !== 'position') throw new Error('kind changed');
    expect(positionMetrics(wider).rr).toBe(before.rr);
    expect(positionMetrics(wider).riskPips).toBe(before.riskPips);
  });

  it('clamps the left edge so the box cannot be collapsed or inverted', () => {
    // Dragged past the right edge: it stops one minimum width short of it.
    const out = moveHandle(long, 3, { time: 99_999, price: 0 });
    if (out.kind !== 'position') throw new Error('kind changed');
    expect(out.time).toBe(2000 - MIN_POSITION_WIDTH_SECONDS);
    expect(out.time).toBeLessThan(out.endTime);
  });

  it('clamps the right edge the same way', () => {
    const out = moveHandle(long, 4, { time: -99_999, price: 0 });
    if (out.kind !== 'position') throw new Error('kind changed');
    expect(out.endTime).toBe(1000 + MIN_POSITION_WIDTH_SECONDS);
    expect(out.endTime).toBeGreaterThan(out.time);
  });

  it('leaves a position untouched for a handle index it does not define', () => {
    expect(moveHandle(long, 5, { time: 0, price: 0 })).toEqual(long);
  });

  it('never mutates the input for any kind', () => {
    for (const d of [trendline, hline, rect, fib, long]) {
      const before = structuredClone(d);
      moveHandle(d, 0, { time: 42, price: 42 });
      expect(d).toEqual(before);
    }
  });
});

/* ---------- drawingFromDraft ---------- */

describe('drawingFromDraft', () => {
  const draft = (d: Partial<Draft> & Pick<Draft, 'tool'>): Draft => ({
    points: [],
    cursor: null,
    ...d,
  });

  it('returns null for an incomplete draft', () => {
    expect(drawingFromDraft(draft({ tool: 'trendline' }), 'x', DEFAULT_STYLE)).toBeNull();
    expect(
      drawingFromDraft(
        draft({ tool: 'trendline', points: [{ time: 1, price: 1 }] }),
        'x',
        DEFAULT_STYLE,
      ),
    ).toBeNull();
    expect(drawingFromDraft(draft({ tool: 'hline' }), 'x', DEFAULT_STYLE)).toBeNull();
    expect(drawingFromDraft(draft({ tool: 'long', points: [{ time: 1, price: 1 }] }), 'x', DEFAULT_STYLE)).toBeNull();
  });

  it('builds an hline from a single click', () => {
    const out = drawingFromDraft(
      draft({ tool: 'hline', points: [{ time: 1000, price: 105 }] }),
      'id-h',
      DEFAULT_STYLE,
    );
    expect(out).not.toBeNull();
    if (out?.kind !== 'hline') throw new Error('wrong kind');
    expect(out.price).toBe(105);
    expect(out.id).toBe('id-h');
    expect(out.style).toEqual(DEFAULT_STYLE);
    expect(Number.isFinite(out.createdAt)).toBe(true);
  });

  it('builds a vline from a single click, keeping only its time', () => {
    const out = drawingFromDraft(
      draft({ tool: 'vline', points: [{ time: 1789344000, price: 105 }] }),
      'id-v',
      DEFAULT_STYLE,
    );
    expect(out).not.toBeNull();
    if (out?.kind !== 'vline') throw new Error('wrong kind');
    expect(out.time).toBe(1789344000);
    expect(out).not.toHaveProperty('price');
    expect(out.id).toBe('id-v');
    expect(out.style).toEqual(DEFAULT_STYLE);
    expect(out.style).not.toBe(DEFAULT_STYLE);
    expect(Number.isFinite(out.createdAt)).toBe(true);
  });

  it('returns null for a vline draft with no points', () => {
    expect(drawingFromDraft(draft({ tool: 'vline' }), 'x', DEFAULT_STYLE)).toBeNull();
  });

  it('builds trendline, rect and fib from two clicks', () => {
    const pts = [
      { time: 1000, price: 100 },
      { time: 2000, price: 110 },
    ];
    for (const tool of ['trendline', 'rect', 'fib'] as const) {
      const out = drawingFromDraft(draft({ tool, points: pts }), `id-${tool}`, DEFAULT_STYLE);
      expect(out).not.toBeNull();
      expect(out?.kind).toBe(tool);
      if (out && 'a' in out) {
        expect(out.a).toEqual(pts[0]);
        expect(out.b).toEqual(pts[1]);
        expect(out.a).not.toBe(pts[0]);
      }
    }
  });

  it('gives a long a default 1:2 target', () => {
    const out = drawingFromDraft(
      draft({
        tool: 'long',
        points: [
          { time: 1000, price: 100 },
          { time: 1500, price: 90 },
        ],
      }),
      'id-l',
      DEFAULT_STYLE,
    );
    if (out?.kind !== 'position') throw new Error('wrong kind');
    expect(out.side).toBe('long');
    expect(out.entry).toBe(100);
    expect(out.stop).toBe(90);
    expect(out.target).toBeCloseTo(120);
    expect(out.lots).toBe(DEFAULT_LOTS);
    expect(out.time).toBe(1000);
    expect(out.endTime).toBe(1500);
    expect(positionMetrics(out).rr).toBeCloseTo(2);
    expect(positionMetrics(out).invalid).toBe(false);
  });

  it('gives a short a default 1:2 target below entry', () => {
    const out = drawingFromDraft(
      draft({
        tool: 'short',
        points: [
          { time: 2000, price: 100 },
          { time: 1000, price: 105 },
        ],
      }),
      'id-s',
      DEFAULT_STYLE,
    );
    if (out?.kind !== 'position') throw new Error('wrong kind');
    expect(out.side).toBe('short');
    expect(out.entry).toBe(100);
    expect(out.stop).toBe(105);
    expect(out.target).toBeCloseTo(90);
    // Times are normalised to start..end regardless of click order.
    expect(out.time).toBe(1000);
    expect(out.endTime).toBe(2000);
    expect(positionMetrics(out).invalid).toBe(false);
  });

  it('falls back to a nominal width when both clicks share a time', () => {
    const out = drawingFromDraft(
      draft({
        tool: 'long',
        points: [
          { time: 1000, price: 100 },
          { time: 1000, price: 90 },
        ],
      }),
      'id-n',
      DEFAULT_STYLE,
    );
    if (out?.kind !== 'position') throw new Error('wrong kind');
    expect(out.time).toBe(1000);
    expect(out.endTime).toBe(1000 + NOMINAL_POSITION_WIDTH_SECONDS);
  });
});

describe('lerpCoordinate (regression: fractional logical indices)', () => {
  // Guards the bug where xForTime interpolated in LOGICAL space and handed a
  // fractional index to lightweight-charts' logicalToCoordinate(), which
  // returns 0 for any non-integer. Every drawing whose timestamp was not an
  // exact bar time on the current timeframe collapsed to x=0 — i.e. all your
  // drawings stacked at the left edge after switching H1 -> D1.
  const xa = 1451.92; // coordinate of bar 1548
  const xb = 1458.66; // coordinate of bar 1549
  const ta = 1789344000; // 2026-09-14 00:00
  const tb = 1789430400; // 2026-09-15 00:00

  it('places a mid-bar time between the two bar coordinates', () => {
    const mid = lerpCoordinate(xa, xb, ta, tb, ta + 43200); // +12h
    expect(mid).toBeCloseTo((xa + xb) / 2, 6);
    expect(mid).toBeGreaterThan(xa);
    expect(mid).toBeLessThan(xb);
  });

  it('is exact at both endpoints', () => {
    expect(lerpCoordinate(xa, xb, ta, tb, ta)).toBeCloseTo(xa, 9);
    expect(lerpCoordinate(xa, xb, ta, tb, tb)).toBeCloseTo(xb, 9);
  });

  it('never returns 0 for a time inside the bar span', () => {
    for (let f = 0.05; f < 1; f += 0.05) {
      const x = lerpCoordinate(xa, xb, ta, tb, ta + f * (tb - ta));
      expect(x).not.toBe(0);
      expect(Number.isFinite(x)).toBe(true);
    }
  });

  it('extrapolates past the endpoints rather than clamping', () => {
    expect(lerpCoordinate(xa, xb, ta, tb, tb + (tb - ta))).toBeCloseTo(xb + (xb - xa), 6);
  });

  it('works right-to-left (neighbour below the anchor index)', () => {
    // anchor = bar 1549, neighbour = bar 1548, target 1h past bar 1548
    const x = lerpCoordinate(xb, xa, tb, ta, ta + 3600);
    expect(x).toBeGreaterThan(xa);
    expect(x).toBeLessThan(xb);
    expect(x).toBeCloseTo(xa + (xb - xa) * (3600 / 86400), 6);
  });

  it('degenerate and non-finite inputs do not produce NaN coordinates', () => {
    expect(lerpCoordinate(xa, xb, ta, ta, ta)).toBe(xa);
    expect(Number.isNaN(lerpCoordinate(Number.NaN, xb, ta, tb, ta))).toBe(true);
  });
});
