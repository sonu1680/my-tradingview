/**
 * Contract for the chart drawing tools.
 *
 * Anchoring rule (the one that matters): every drawing is stored in absolute
 * (time, price) — never bar index, never pixels. That is what makes a line
 * drawn on H1 land in the right place on M1 and D1, and what makes drawings
 * survive scroll and zoom for free.
 *
 * Consequence to handle in the renderer: a drawing's `time` will usually NOT
 * be an exact bar timestamp on another timeframe, so the library's
 * time->coordinate conversion returns null. The x coordinate must be
 * interpolated from the surrounding bars instead. Skipping this is what makes
 * drawings appear to "randomly vanish" when the timeframe changes.
 */

/** A point in chart space. `time` is unix seconds (broker server time). */
export interface Anchor {
  time: number;
  price: number;
}

export interface DrawingStyle {
  color: string;
  width: number;
}

export const DEFAULT_STYLE: DrawingStyle = { color: '#2962FF', width: 2 };

export type DrawingKind =
  | 'trendline'
  | 'hline'
  | 'vline'
  | 'rect'
  | 'fib'
  | 'position';

interface DrawingBase {
  id: string;
  kind: DrawingKind;
  style: DrawingStyle;
  /** Unix ms, for stable ordering and "most recent" semantics. */
  createdAt: number;
}

export interface TrendlineDrawing extends DrawingBase {
  kind: 'trendline';
  a: Anchor;
  b: Anchor;
}

/** Spans the full chart width; only `price` is meaningful. */
export interface HLineDrawing extends DrawingBase {
  kind: 'hline';
  price: number;
}

/**
 * Spans the full chart height; only `time` is meaningful.
 * The mirror image of `hline`: one click, no handles, dragged in time only.
 * Anchored in absolute time, so it lands on the right bar on every timeframe.
 */
export interface VLineDrawing extends DrawingBase {
  kind: 'vline';
  time: number;
}

export interface RectDrawing extends DrawingBase {
  kind: 'rect';
  a: Anchor;
  b: Anchor;
}

/** `a` is the 0 level, `b` the 1 level. Levels are drawn between them. */
export interface FibDrawing extends DrawingBase {
  kind: 'fib';
  a: Anchor;
  b: Anchor;
}

/**
 * The TradingView-style position tool.
 * `time`..`endTime` is the horizontal span of the bands.
 */
export interface PositionDrawing extends DrawingBase {
  kind: 'position';
  side: 'long' | 'short';
  time: number;
  endTime: number;
  entry: number;
  stop: number;
  target: number;
  /** Lot size; drives the dollar figures. */
  lots: number;
}

export type Drawing =
  | TrendlineDrawing
  | HLineDrawing
  | VLineDrawing
  | RectDrawing
  | FibDrawing
  | PositionDrawing;

/** Standard retracement levels, drawn a=0 -> b=1. */
export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/**
 * XAUUSD contract size: 100 troy oz per 1.00 lot, so a $1 move is $100 per
 * lot. At the 0.01 default, a $1 move is $1.
 */
export const XAUUSD_CONTRACT_SIZE = 100;
export const DEFAULT_LOTS = 0.01;

/** Pip size for the dollar/pip readouts; matches the indicator's convention. */
export const PIP_SIZE = 0.01;

/* ---------- Tools ---------- */

export type ToolId =
  | 'cursor'
  | 'trendline'
  | 'hline'
  | 'vline'
  | 'rect'
  | 'fib'
  | 'long'
  | 'short';

/** How many clicks each tool needs before the drawing is committed. */
export const TOOL_CLICKS: Record<Exclude<ToolId, 'cursor'>, 1 | 2> = {
  trendline: 2,
  hline: 1,
  vline: 1,
  rect: 2,
  fib: 2,
  long: 2,
  short: 2,
};

/* ---------- Geometry (screen space) ---------- */

/** A pixel-space point, in CSS pixels relative to the chart canvas. */
export interface Pt {
  x: number;
  y: number;
}

/**
 * A drawing projected into screen space by the caller, who owns the chart's
 * coordinate converters. Geometry code is pure and never touches the chart.
 *
 * `points` are the drawing's own anchors in order (the same order the handles
 * appear in). For `hline` this is a single point whose `x` is meaningless;
 * for `vline` a single point whose `y` is meaningless.
 */
export interface Projected {
  drawing: Drawing;
  points: Pt[];
}

export type Hit =
  /** The shape's body — drag to move the whole thing. */
  | { type: 'body' }
  /** A specific handle, indexed into `Projected.points`. */
  | { type: 'handle'; index: number };

/** Pixel tolerance for hit-testing a line, and the handle square's half-size. */
export const HIT_TOLERANCE = 6;
export const HANDLE_SIZE = 8;

/* ---------- Position metrics ---------- */

export interface PositionMetrics {
  /** Absolute price distances. */
  riskPrice: number;
  rewardPrice: number;
  riskPips: number;
  rewardPips: number;
  /** Reward / risk. `null` when risk is zero (stop == entry). */
  rr: number | null;
  riskUsd: number;
  rewardUsd: number;
  /** True when stop/target sit on the wrong side of entry for the side. */
  invalid: boolean;
}

/* ---------- Renderer state ---------- */

/** An in-progress placement, before the drawing is committed. */
export interface Draft {
  tool: Exclude<ToolId, 'cursor'>;
  /** Anchors clicked so far. */
  points: Anchor[];
  /** Live cursor position, for the rubber-band preview. */
  cursor: Anchor | null;
}

/** Everything the renderer needs. It is otherwise stateless. */
export interface DrawingsViewState {
  drawings: Drawing[];
  selectedId: string | null;
  hoverId: string | null;
  draft: Draft | null;
}

export const EMPTY_VIEW_STATE: DrawingsViewState = {
  drawings: [],
  selectedId: null,
  hoverId: null,
  draft: null,
};

/* ---------- Persistence ---------- */

/** Bump when the shape of `Drawing` changes; unknown versions are discarded. */
export const DRAWINGS_SCHEMA_VERSION = 1;

export interface DrawingsFile {
  version: number;
  symbol: string;
  drawings: Drawing[];
}
