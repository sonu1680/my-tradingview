/**
 * Canvas renderer for the chart drawing tools.
 *
 * ONE series primitive draws every drawing — trendlines, horizontal and
 * vertical lines, rectangles, fib retracements, position tools, the selection
 * handles, the hover emphasis and the in-progress draft. Nothing is created per drawing:
 * a single pane view and a single renderer serve the whole set, so the cost of
 * having drawings enabled is one `attachPrimitive` call.
 *
 * This file also owns ALL coordinate conversion, in both directions
 * (`project` / `toPoint` / `toAnchor`). The interaction layer must never touch
 * the chart's own converters: two implementations of time->x would drift apart
 * and hit-testing would stop matching what is actually painted.
 *
 * ---------------------------------------------------------------------------
 * Projection order — matches `lib/drawings/geometry.ts` exactly
 * ---------------------------------------------------------------------------
 *   trendline  [0]=a            [1]=b
 *   rect       [0]=a            [1]=b            (opposite corners)
 *   fib        [0]=a (the 0 level)               [1]=b (the 1 level)
 *   hline      [0]=the line; `x` is synthetic (canvas centre) and meaningless.
 *              `handlePositions` returns [] for it — the line is the grab area.
 *   vline      [0]=the line; `y` is synthetic (canvas centre) and meaningless.
 *              The transpose of hline: no handles, the line is the grab area.
 *   position   [0]=entry at the LEFT edge (x of `time`)
 *              [1]=stop, [2]=target, both at the RIGHT edge (x of `endTime`)
 *              [3]=left edge, [4]=right edge, both at the box's vertical
 *              middle — the WIDTH handles, which drag `time` / `endTime`.
 *
 * Handles are drawn from `handlePositions(projected)`, never from
 * `Projected.points` directly, so what is painted is exactly what hit-tests.
 */

import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import {
  DEFAULT_STYLE,
  EMPTY_VIEW_STATE,
  HANDLE_SIZE,
  type Anchor,
  type Draft,
  type Drawing,
  type DrawingsViewState,
  type PositionDrawing,
  type Projected,
  type Pt,
} from '@/lib/drawings/types';
import {
  drawingFromDraft,
  fibLevels,
  handlePositions,
  lerpCoordinate,
  positionMetrics,
} from '@/lib/drawings/geometry';
import { LABEL_FONT_PX, labelFontFamily } from '../labelFont';

/** The `fancy-canvas` target the library hands to `draw`, without importing it. */
type RenderTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

/* ---------- constants ---------- */

/** Shapes this far outside the canvas are dropped before any drawing happens. */
const CULL_MARGIN = 64;

/** Padding and leading grow with the 13px label font. */
const LABEL_PAD_X = 5;
const LABEL_PAD_Y = 4;
const LABEL_LINE_GAP = 3;

/** TradingView's position-tool semantics. Not the drawing's style colour. */
const RISK_COLOR = '#F23645';
const REWARD_COLOR = '#089981';
/** `metrics.invalid` — stop/target on the wrong side of entry. */
const WARN_COLOR = '#FF9800';

const BAND_ALPHA = 0.16;
const RECT_FILL_ALPHA = 0.08;
const LABEL_BG_ALPHA = 0.85;
const HANDLE_FILL = '#FFFFFF';
const HANDLE_BORDER = '#131722';
const LABEL_TEXT = '#FFFFFF';

const DRAFT_DASH = [5, 4];
/** Id given to the throwaway preview drawing built from a draft. */
const DRAFT_ID = '__draft__';
const DRAFT_ALPHA = 0.7;
const HOVER_GLOW = 6;
const HOVER_EXTRA_WIDTH = 1;
const SELECTED_EXTRA_WIDTH = 1;
/** Non-structural fib levels are faded relative to 0 / 0.5 / 1. */
const FIB_MINOR_ALPHA = 0.55;

/* ---------- small helpers ---------- */

/**
 * `#RGB` / `#RRGGBB` (and `#RRGGBBAA`) to `rgba(...)` at the given opacity.
 * Anything unparseable falls back to the input, so a CSS colour name still
 * renders — just without the alpha.
 */
function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  if (hex.charCodeAt(0) !== 35 /* # */) return hex;
  const body = hex.slice(1);
  let r: number;
  let g: number;
  let b: number;
  if (body.length === 3) {
    r = parseInt(body[0] + body[0], 16);
    g = parseInt(body[1] + body[1], 16);
    b = parseInt(body[2] + body[2], 16);
  } else if (body.length === 6 || body.length === 8) {
    r = parseInt(body.slice(0, 2), 16);
    g = parseInt(body.slice(2, 4), 16);
    b = parseInt(body.slice(4, 6), 16);
  } else {
    return hex;
  }
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** `0.618` -> `"0.618"`, `0.5` -> `"0.5"`, `1` -> `"1"`. */
function ratioText(ratio: number): string {
  if (!Number.isFinite(ratio)) return '?';
  return ratio
    .toFixed(3)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}

function usd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function pips(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

/**
 * `YYYY-MM-DD HH:MM` in UTC. Drawing times are broker server time and the
 * axis shows them unshifted, so the tag must not pass through the local zone.
 */
function utcMinute(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const d = new Date(seconds * 1000);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

/** Any `Time` the library may hand back, reduced to unix seconds. */
function timeToSeconds(time: Time): number | null {
  if (typeof time === 'number') return Number.isFinite(time) ? time : null;
  if (typeof time === 'string') {
    const ms = Date.parse(time.length === 10 ? `${time}T00:00:00Z` : time);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  if (typeof time === 'object' && time !== null) {
    const ms = Date.UTC(time.year, time.month - 1, time.day);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  return null;
}

/* ---------- coordinate space ---------- */

/**
 * Bidirectional chart-space <-> pixel-space conversion, with a per-instance
 * index->time cache. Construct one per draw / per public call; it is cheap and
 * the cache must not outlive a single coordinate snapshot.
 *
 * Precision, stated plainly:
 *  - price <-> y is exact (the library's own converters).
 *  - time -> x is EXACT for a timestamp that is a real bar time; otherwise it
 *    is linearly interpolated between the two surrounding bars, so the error
 *    is bounded by the non-linearity of time inside a single bar (i.e. none,
 *    for evenly spaced sessions) and is at worst sub-bar.
 *  - x -> time is exact at a bar's own x; between bars it is the same linear
 *    interpolation, rounded to whole seconds (`Anchor.time` is unix seconds).
 *  - Past either end of the data there are no surrounding bars, so both
 *    directions EXTRAPOLATE using the interval between the last two bars.
 *    Across a weekend/session gap that is approximate by construction; it
 *    keeps drawings placeable in the empty space to the right instead of
 *    returning null, which is the trade this code deliberately makes.
 */
class Coords {
  private readonly _chart: IChartApiBase<Time>;
  private readonly _series: ISeriesApi<SeriesType, Time>;
  private readonly _timeAt = new Map<number, number | null>();
  private readonly _coordAt = new Map<number, number | null>();
  private _spacingCache: number | null | undefined;
  private _boundsCache: { first: number; last: number } | null | undefined;
  private _stepCache: number | null | undefined;

  public constructor(chart: IChartApiBase<Time>, series: ISeriesApi<SeriesType, Time>) {
    this._chart = chart;
    this._series = series;
  }

  /** First and last real data index, or null when it cannot be determined. */
  private _bounds(): { first: number; last: number } | null {
    if (this._boundsCache !== undefined) return this._boundsCache;
    let out: { first: number; last: number } | null = null;
    const range = this._chart.timeScale().getVisibleLogicalRange();
    if (range !== null) {
      const info = this._series.barsInLogicalRange(range);
      if (info !== null && Number.isFinite(info.barsBefore) && Number.isFinite(info.barsAfter)) {
        const first = Math.round(range.from - info.barsBefore);
        const last = Math.round(range.to + info.barsAfter);
        if (Number.isFinite(first) && Number.isFinite(last) && last >= first) {
          out = { first, last };
        }
      }
    }
    this._boundsCache = out;
    return out;
  }

  private _inBounds(index: number): boolean {
    const b = this._bounds();
    if (b === null) return true;
    return index >= b.first && index <= b.last;
  }

  /** Seconds per bar, from the last two bars. Null when undeterminable. */
  private _step(): number | null {
    if (this._stepCache !== undefined) return this._stepCache;
    let out: number | null = null;
    const b = this._bounds();
    if (b !== null && b.last > b.first) {
      const last = this.timeAtIndex(b.last);
      const prev = this.timeAtIndex(b.last - 1);
      if (last !== null && prev !== null && last > prev) out = last - prev;
    }
    this._stepCache = out;
    return out;
  }

  /**
   * Unix seconds of the bar at a logical index.
   *
   * There is no public `indexToTime`, so this goes index -> coordinate ->
   * time. `coordinateToTime` clamps to the nearest bar, so a caller must not
   * trust a result for an out-of-bounds index — callers here guard with
   * `_inBounds` and by rejecting a neighbour whose time equals the anchor's.
   */
  public timeAtIndex(index: number): number | null {
    const cached = this._timeAt.get(index);
    if (cached !== undefined) return cached;
    let out: number | null = null;
    const ts = this._chart.timeScale();
    const coord = ts.logicalToCoordinate(index as unknown as Logical);
    if (coord !== null && Number.isFinite(coord)) {
      const time = ts.coordinateToTime(coord);
      if (time !== null) out = timeToSeconds(time);
    }
    this._timeAt.set(index, out);
    return out;
  }

  /**
   * Media-space x of the bar at an INTEGER logical index.
   * Memoised; fractional indices are rejected because the library returns 0
   * for them (see `lerpCoordinate`).
   */
  public coordAtIndex(index: number): number | null {
    if (!Number.isInteger(index)) return null;
    const cached = this._coordAt.get(index);
    if (cached !== undefined) return cached;
    const x = this._chart.timeScale().logicalToCoordinate(index as unknown as Logical);
    const out = x !== null && Number.isFinite(x) ? (x as number) : null;
    this._coordAt.set(index, out);
    return out;
  }

  /** Pixels per bar, measured from two real bars. Null when undeterminable. */
  private _barSpacing(): number | null {
    if (this._spacingCache !== undefined) return this._spacingCache;
    let out: number | null = null;
    const b = this._bounds();
    if (b !== null && b.last > b.first) {
      const a = this.coordAtIndex(b.last - 1);
      const c = this.coordAtIndex(b.last);
      if (a !== null && c !== null && c !== a) out = c - a;
    }
    this._spacingCache = out;
    return out;
  }

  /** Media-space x for an absolute timestamp, interpolating between bars. */
  public xForTime(time: number): number | null {
    if (!Number.isFinite(time)) return null;
    const ts = this._chart.timeScale();

    const direct = ts.timeToCoordinate(time as UTCTimestamp);
    if (direct !== null && Number.isFinite(direct)) return direct;

    // Not an exact bar time on this timeframe — the common case for a drawing
    // made on another timeframe. Snap to the nearest bar, then interpolate.
    const rawIndex = ts.timeToIndex(time as UTCTimestamp, true);
    if (rawIndex === null) return null;
    const index = rawIndex as unknown as number;
    if (!Number.isFinite(index)) return null;

    // Interpolate in COORDINATE space, never in logical space:
    // `logicalToCoordinate` accepts only integer logicals and silently
    // returns 0 for a fractional one, which would collapse every off-bar
    // drawing to the left edge. See `lerpCoordinate`.
    const xAnchor = this.coordAtIndex(index);
    if (xAnchor === null) return null;

    const anchorTime = this.timeAtIndex(index);
    if (anchorTime === null || anchorTime === time) return xAnchor;

    const neighbour = time > anchorTime ? index + 1 : index - 1;
    if (this._inBounds(neighbour)) {
      const neighbourTime = this.timeAtIndex(neighbour);
      const xNeighbour = this.coordAtIndex(neighbour);
      if (
        neighbourTime !== null &&
        xNeighbour !== null &&
        neighbourTime !== anchorTime
      ) {
        const x = lerpCoordinate(xAnchor, xNeighbour, anchorTime, neighbourTime, time);
        return Number.isFinite(x) ? x : xAnchor;
      }
    }

    // At a data edge there is no neighbour bar, so extrapolate by the bar
    // interval in time and the bar spacing in pixels. Approximate across
    // weekend gaps, which is the deliberate trade for keeping drawings
    // placeable beyond the last bar.
    const step = this._step();
    const spacing = this._barSpacing();
    if (step !== null && spacing !== null && step !== 0) {
      const x = xAnchor + ((time - anchorTime) / step) * spacing;
      if (Number.isFinite(x)) return x;
    }
    return xAnchor;
  }

  /** Absolute timestamp (unix seconds) for a media-space x. */
  public timeForX(x: number): number | null {
    if (!Number.isFinite(x)) return null;
    const ts = this._chart.timeScale();
    const rawLogical = ts.coordinateToLogical(x);
    if (rawLogical === null) return null;
    const logical = rawLogical as unknown as number;
    if (!Number.isFinite(logical)) return null;

    const bounds = this._bounds();
    const low = Math.floor(logical);
    const high = low + 1;

    if (bounds === null) {
      // No data bounds: fall back to the library's own nearest-bar answer.
      const time = ts.coordinateToTime(x);
      const seconds = time === null ? null : timeToSeconds(time);
      return seconds === null ? null : Math.round(seconds);
    }

    if (low >= bounds.first && high <= bounds.last) {
      const tLow = this.timeAtIndex(low);
      const tHigh = this.timeAtIndex(high);
      if (tLow !== null && tHigh !== null) {
        const t = tLow + (logical - low) * (tHigh - tLow);
        return Number.isFinite(t) ? Math.round(t) : null;
      }
    }

    // Outside the data: clamp to the nearest real bar and extrapolate.
    const edge = Math.min(Math.max(Math.round(logical), bounds.first), bounds.last);
    const edgeTime = this.timeAtIndex(edge);
    if (edgeTime === null) return null;
    const step = this._step();
    const t = step === null ? edgeTime : edgeTime + (logical - edge) * step;
    return Number.isFinite(t) ? Math.round(t) : null;
  }

  public yForPrice(price: number): number | null {
    if (!Number.isFinite(price)) return null;
    const y = this._series.priceToCoordinate(price);
    return y !== null && Number.isFinite(y) ? y : null;
  }

  public priceForY(y: number): number | null {
    if (!Number.isFinite(y)) return null;
    const price = this._series.coordinateToPrice(y);
    return price !== null && Number.isFinite(price) ? price : null;
  }

  public toPoint(anchor: Anchor): Pt | null {
    const x = this.xForTime(anchor.time);
    if (x === null) return null;
    const y = this.yForPrice(anchor.price);
    if (y === null) return null;
    return { x, y };
  }

  public toAnchor(point: Pt): Anchor | null {
    const time = this.timeForX(point.x);
    if (time === null) return null;
    const price = this.priceForY(point.y);
    if (price === null) return null;
    return { time, price };
  }

  public format(price: number): string {
    if (!Number.isFinite(price)) return '—';
    try {
      return this._series.priceFormatter().format(price);
    } catch {
      return price.toFixed(2);
    }
  }
}

/* ---------- draw environment + primitives ---------- */

interface Env {
  ctx: CanvasRenderingContext2D;
  /** Horizontal / vertical device-pixel ratios. */
  hr: number;
  vr: number;
  /** Media (CSS px) size. */
  w: number;
  h: number;
  /** Bitmap (device px) size — labels are clamped against this. */
  bw: number;
  bh: number;
  coords: Coords;
  /**
   * Labels are drawn ONLY for the selected drawing and the live draft.
   * On a higher timeframe a handful of drawings collapse into a few pixels
   * and their label blocks stack into an unreadable pile; showing them only
   * for what you have selected keeps the chart legible at every zoom.
   * Also forced off for a drawing too narrow on screen to be worth labelling.
   */
  labels: boolean;
  /**
   * Label rects already painted this frame, in bitmap space. A label that
   * would overlap one is skipped rather than drawn on top — a fib's own seven
   * levels collide with each other once the price axis is compressed.
   */
  placed: LabelRect[];
}

interface LabelRect {
  l: number;
  t: number;
  r: number;
  b: number;
}

/**
 * Below this on-screen width a drawing is a sliver, and its labels would be
 * wider than the shape they describe. Raised with the label font: a 13px block
 * needs more room than the 10px one before it earns its place.
 */
const MIN_LABEL_SPAN_PX = 40;

type Dash = readonly number[] | null;

function line(
  env: Env,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  widthMedia: number,
  dash: Dash = null,
): void {
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    return;
  }
  const { ctx } = env;
  const lw = Math.max(1, Math.round(widthMedia * env.vr));
  let ax = x1 * env.hr;
  let bx = x2 * env.hr;
  let ay = y1 * env.vr;
  let by = y2 * env.vr;
  const offset = lw % 2 === 1 ? 0.5 : 0;
  if (Math.abs(ay - by) < 0.5) {
    ay = Math.round(ay) + offset;
    by = ay;
  }
  if (Math.abs(ax - bx) < 0.5) {
    ax = Math.round(ax) + offset;
    bx = ax;
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.setLineDash(dash === null ? [] : dash.map((d) => d * env.hr));
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.restore();
}

function fillBox(env: Env, x1: number, y1: number, x2: number, y2: number, color: string): void {
  const left = Math.round(Math.min(x1, x2) * env.hr);
  const right = Math.round(Math.max(x1, x2) * env.hr);
  const top = Math.round(Math.min(y1, y2) * env.vr);
  const bottom = Math.round(Math.max(y1, y2) * env.vr);
  if (right <= left || bottom <= top) return;
  env.ctx.save();
  env.ctx.fillStyle = color;
  env.ctx.fillRect(left, top, right - left, bottom - top);
  env.ctx.restore();
}

function strokeBox(
  env: Env,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  widthMedia: number,
  dash: Dash = null,
): void {
  const lw = Math.max(1, Math.round(widthMedia * env.vr));
  const half = lw / 2;
  const left = Math.round(Math.min(x1, x2) * env.hr) + half;
  const right = Math.round(Math.max(x1, x2) * env.hr) - half;
  const top = Math.round(Math.min(y1, y2) * env.vr) + half;
  const bottom = Math.round(Math.max(y1, y2) * env.vr) - half;
  env.ctx.save();
  env.ctx.strokeStyle = color;
  env.ctx.lineWidth = lw;
  env.ctx.setLineDash(dash === null ? [] : dash.map((d) => d * env.hr));
  env.ctx.strokeRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
  env.ctx.restore();
}

interface LabelOptions {
  bg: string;
  fg?: string;
  /** Horizontal anchoring of `x`. */
  align?: 'left' | 'center' | 'right';
  /** Vertical anchoring of `y`. */
  baseline?: 'top' | 'middle' | 'bottom';
  /** Optional accent strip down the left edge. */
  accent?: string;
}

/**
 * A label block, in media coordinates, clamped so it always stays on-canvas.
 * Everything — font, padding, the box — is scaled by the pixel ratios.
 */
function drawLabel(
  env: Env,
  lines: readonly string[],
  x: number,
  y: number,
  options: LabelOptions,
): void {
  if (lines.length === 0) return;
  if (!env.labels) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const { ctx } = env;
  const fontPx = LABEL_FONT_PX * env.vr;
  const padX = LABEL_PAD_X * env.hr;
  const padY = LABEL_PAD_Y * env.vr;
  const gap = LABEL_LINE_GAP * env.vr;

  ctx.save();
  ctx.font = `${fontPx}px ${labelFontFamily()}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  let textWidth = 0;
  for (const text of lines) textWidth = Math.max(textWidth, ctx.measureText(text).width);
  const boxWidth = textWidth + padX * 2;
  const boxHeight = lines.length * fontPx + (lines.length - 1) * gap + padY * 2;

  let left = x * env.hr;
  if (options.align === 'right') left -= boxWidth;
  else if (options.align === 'center') left -= boxWidth / 2;
  let top = y * env.vr;
  if (options.baseline === 'middle') top -= boxHeight / 2;
  else if (options.baseline === 'bottom') top -= boxHeight;

  // Clamp back inside the canvas rather than letting the label run off.
  left = Math.min(Math.max(0, left), Math.max(0, env.bw - boxWidth));
  top = Math.min(Math.max(0, top), Math.max(0, env.bh - boxHeight));

  // Collision skip. Order decides the winner, so callers draw the labels that
  // matter most first (see `drawFib`).
  const rect: LabelRect = { l: left, t: top, r: left + boxWidth, b: top + boxHeight };
  for (const other of env.placed) {
    const overlaps =
      rect.l < other.r && rect.r > other.l && rect.t < other.b && rect.b > other.t;
    if (overlaps) {
      ctx.restore();
      return;
    }
  }
  env.placed.push(rect);

  ctx.fillStyle = options.bg;
  ctx.fillRect(left, top, boxWidth, boxHeight);
  if (options.accent !== undefined) {
    ctx.fillStyle = options.accent;
    ctx.fillRect(left, top, Math.max(1, Math.round(2 * env.hr)), boxHeight);
  }
  ctx.fillStyle = options.fg ?? LABEL_TEXT;
  let lineTop = top + padY;
  for (const text of lines) {
    ctx.fillText(text, left + padX, lineTop);
    lineTop += fontPx + gap;
  }
  ctx.restore();
}

/** `HANDLE_SIZE` squares, white with a dark border so they read anywhere. */
function drawHandles(env: Env, points: readonly Pt[]): void {
  const { ctx } = env;
  const half = HANDLE_SIZE / 2;
  const border = Math.max(1, Math.round(env.vr));
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = border;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const left = Math.round((p.x - half) * env.hr);
    const top = Math.round((p.y - half) * env.vr);
    const w = Math.max(2, Math.round(HANDLE_SIZE * env.hr));
    const h = Math.max(2, Math.round(HANDLE_SIZE * env.vr));
    if (left + w < 0 || top + h < 0 || left > env.bw || top > env.bh) continue;
    ctx.fillStyle = HANDLE_FILL;
    ctx.fillRect(left, top, w, h);
    ctx.strokeStyle = HANDLE_BORDER;
    ctx.strokeRect(left + border / 2, top + border / 2, w - border, h - border);
  }
  ctx.restore();
}

/** Small marker for an already-placed draft point. */
function drawDraftPoint(env: Env, p: Pt, color: string): void {
  const size = Math.max(3, Math.round(4 * env.hr));
  const left = Math.round(p.x * env.hr) - size / 2;
  const top = Math.round(p.y * env.vr) - size / 2;
  env.ctx.save();
  env.ctx.fillStyle = color;
  env.ctx.fillRect(left, top, size, size);
  env.ctx.restore();
}

/* ---------- per-kind drawing ---------- */

type Emphasis = 'none' | 'hover' | 'selected';

function widthFor(base: number, emphasis: Emphasis): number {
  const w = Number.isFinite(base) && base > 0 ? base : DEFAULT_STYLE.width;
  if (emphasis === 'hover') return w + HOVER_EXTRA_WIDTH;
  if (emphasis === 'selected') return w + SELECTED_EXTRA_WIDTH;
  return w;
}

function offY(env: Env, y: number): boolean {
  return y < -CULL_MARGIN || y > env.h + CULL_MARGIN;
}

function offX(env: Env, x: number): boolean {
  return x < -CULL_MARGIN || x > env.w + CULL_MARGIN;
}

function offXSpan(env: Env, x1: number, x2: number): boolean {
  return Math.max(x1, x2) < -CULL_MARGIN || Math.min(x1, x2) > env.w + CULL_MARGIN;
}

function drawTrendline(
  env: Env,
  a: Pt,
  b: Pt,
  color: string,
  width: number,
  dash: Dash,
): void {
  if (offXSpan(env, a.x, b.x)) return;
  if (Math.max(a.y, b.y) < -CULL_MARGIN || Math.min(a.y, b.y) > env.h + CULL_MARGIN) return;
  line(env, a.x, a.y, b.x, b.y, color, width, dash);
}

/** Spans the full width, so it is culled on y only. */
function drawHLine(
  env: Env,
  y: number,
  price: number,
  color: string,
  width: number,
  dash: Dash,
): void {
  if (offY(env, y)) return;
  line(env, 0, y, env.w, y, color, width, dash);
  drawLabel(env, [env.coords.format(price)], env.w - 2, y, {
    bg: withAlpha(color, LABEL_BG_ALPHA),
    align: 'right',
    baseline: 'middle',
  });
}

/**
 * Spans the full height, so it is culled on x only. The time tag sits at the
 * bottom edge, centred on the line, and goes through `drawLabel` so it obeys
 * the labels-only-when-selected rule like every other label.
 */
function drawVLine(
  env: Env,
  x: number,
  time: number,
  color: string,
  width: number,
  dash: Dash,
): void {
  if (offX(env, x)) return;
  line(env, x, 0, x, env.h, color, width, dash);
  drawLabel(env, [utcMinute(time)], x, env.h - 2, {
    bg: withAlpha(color, LABEL_BG_ALPHA),
    align: 'center',
    baseline: 'bottom',
  });
}

function drawRect(env: Env, a: Pt, b: Pt, color: string, width: number, dash: Dash): void {
  if (offXSpan(env, a.x, b.x)) return;
  if (Math.max(a.y, b.y) < -CULL_MARGIN || Math.min(a.y, b.y) > env.h + CULL_MARGIN) return;
  // Visible-but-unobtrusive fill: the candles must still read through it.
  fillBox(env, a.x, a.y, b.x, b.y, withAlpha(color, RECT_FILL_ALPHA));
  strokeBox(env, a.x, a.y, b.x, b.y, color, width, dash);
}

/**
 * The 7 `FIB_RATIOS` levels between `a` and `b`. Each level spans the width, so
 * levels are culled on y individually; the whole shape is culled on x first.
 */
function drawFib(
  env: Env,
  a: Anchor,
  b: Anchor,
  x1: number,
  x2: number,
  color: string,
  width: number,
  dash: Dash,
): void {
  if (offXSpan(env, x1, x2)) return;
  const levels = fibLevels(a, b);
  const labelX = Math.max(x1, x2) + 4;
  const isStructural = (ratio: number): boolean =>
    ratio === 0 || ratio === 0.5 || ratio === 1;

  for (const level of levels) {
    const y = env.coords.yForPrice(level.price);
    if (y === null || offY(env, y)) continue;
    const structural = isStructural(level.ratio);
    const levelColor = structural ? color : withAlpha(color, FIB_MINOR_ALPHA);
    const levelWidth = structural ? width : Math.max(1, width * 0.75);
    line(env, x1, y, x2, y, levelColor, levelWidth, dash);
  }

  // Labels in a second pass, structural levels first: collision skipping is
  // order-dependent, and losing 0 / 0.5 / 1 to a minor level would be the
  // wrong trade.
  const byPriority = [...levels].sort(
    (p, q) => Number(isStructural(q.ratio)) - Number(isStructural(p.ratio)),
  );
  for (const level of byPriority) {
    const y = env.coords.yForPrice(level.price);
    if (y === null || offY(env, y)) continue;
    drawLabel(env, [`${ratioText(level.ratio)}  ${env.coords.format(level.price)}`], labelX, y, {
      bg: withAlpha(color, LABEL_BG_ALPHA),
      baseline: 'middle',
    });
  }
}

/**
 * A band that fades away from its anchor edge.
 *
 * `y1` is the anchored edge (entry) and `y2` the far one (stop or target), and
 * the argument order is preserved rather than normalised, so the gradient
 * always runs outward from entry whichever way the band points. A flat fill
 * reads as a solid block; the fade keeps the candles underneath legible while
 * still making the zone obvious.
 */
function fillBand(
  env: Env,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
): void {
  const left = Math.round(Math.min(x1, x2) * env.hr);
  const right = Math.round(Math.max(x1, x2) * env.hr);
  const top = Math.round(Math.min(y1, y2) * env.vr);
  const bottom = Math.round(Math.max(y1, y2) * env.vr);
  if (right <= left || bottom <= top) return;

  const { ctx } = env;
  ctx.save();
  const from = y1 * env.vr;
  const to = y2 * env.vr;
  if (Number.isFinite(from) && Number.isFinite(to) && from !== to) {
    const gradient = ctx.createLinearGradient(0, from, 0, to);
    gradient.addColorStop(0, withAlpha(color, BAND_ALPHA * 1.6));
    gradient.addColorStop(1, withAlpha(color, BAND_ALPHA * 0.35));
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = withAlpha(color, BAND_ALPHA);
  }
  ctx.fillRect(left, top, right - left, bottom - top);
  ctx.restore();
}

/**
 * A compact pill, vertically centred on `y` with its left edge at `x`.
 *
 * Unlike `drawLabel` this is NOT gated on `env.labels`: the level readouts are
 * the point of the position tool and stay visible whether or not the drawing
 * is selected. `drawPosition` suppresses them on a box too narrow to hold one.
 */
function drawChip(
  env: Env,
  text: string,
  x: number,
  y: number,
  bg: string,
  fg: string,
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const { ctx } = env;
  const fontPx = Math.round(LABEL_FONT_PX * 0.85 * env.vr);
  ctx.save();
  ctx.font = `600 ${fontPx}px ${labelFontFamily()}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const padX = 4 * env.hr;
  const padY = 2.5 * env.vr;
  const w = ctx.measureText(text).width + padX * 2;
  const h = fontPx + padY * 2;
  const left = Math.round(x * env.hr);
  const top = Math.round(y * env.vr - h / 2);
  ctx.fillStyle = bg;
  ctx.fillRect(left, top, w, h);
  ctx.fillStyle = fg;
  ctx.fillText(text, left + padX, Math.round(y * env.vr));
  ctx.restore();
}

/** Narrower than this and the level pills are dropped rather than overflowed. */
const MIN_CHIP_SPAN_PX = 96;

function drawPosition(
  env: Env,
  drawing: PositionDrawing,
  x1: number,
  x2: number,
  yEntry: number,
  yStop: number,
  yTarget: number,
  color: string,
  width: number,
  dash: Dash,
): void {
  if (offXSpan(env, x1, x2)) return;
  const top = Math.min(yEntry, yStop, yTarget);
  const bottom = Math.max(yEntry, yStop, yTarget);
  if (bottom < -CULL_MARGIN || top > env.h + CULL_MARGIN) return;

  const metrics = positionMetrics(drawing);

  if (metrics.invalid) {
    // Mid-drag, with the stop or target on the wrong side of entry. Do NOT
    // paint red/green bands — that would read as a valid setup. One muted
    // warning band plus dashed level lines says "this is broken" instead.
    fillBox(env, x1, top, x2, bottom, withAlpha(WARN_COLOR, BAND_ALPHA * 0.6));
    strokeBox(env, x1, top, x2, bottom, WARN_COLOR, width, DRAFT_DASH);
    line(env, x1, yEntry, x2, yEntry, WARN_COLOR, width + 1, DRAFT_DASH);
    line(env, x1, yStop, x2, yStop, withAlpha(WARN_COLOR, 0.8), width, DRAFT_DASH);
    line(env, x1, yTarget, x2, yTarget, withAlpha(WARN_COLOR, 0.8), width, DRAFT_DASH);
    drawLabel(
      env,
      ['INVALID SETUP', `${drawing.side.toUpperCase()}  stop/target on the wrong side`],
      Math.max(x1, x2) + 6,
      top,
      { bg: withAlpha(WARN_COLOR, LABEL_BG_ALPHA), accent: WARN_COLOR },
    );
    return;
  }

  // Risk band: entry -> stop. Reward band: entry -> target. Both fade away
  // from entry, which is the edge the trade is measured from.
  fillBand(env, x1, yEntry, x2, yStop, RISK_COLOR);
  fillBand(env, x1, yEntry, x2, yTarget, REWARD_COLOR);
  strokeBox(env, x1, yEntry, x2, yStop, withAlpha(RISK_COLOR, 0.85), 1, dash);
  strokeBox(env, x1, yEntry, x2, yTarget, withAlpha(REWARD_COLOR, 0.85), 1, dash);

  // The stop and target edges carry their own semantic colour at full weight —
  // they are the two prices that actually get hit.
  line(env, x1, yStop, x2, yStop, RISK_COLOR, width, dash);
  line(env, x1, yTarget, x2, yTarget, REWARD_COLOR, width, dash);
  // Entry is the shared boundary of the two bands, so it gets its own weight
  // and the drawing's style colour.
  line(env, x1, yEntry, x2, yEntry, color, width + 1, dash);

  const rr = metrics.rr === null ? '—' : metrics.rr.toFixed(2);

  // Selected: mark the two vertical edges, which are the width handles. The
  // square handles sit on them, but the full-height rule is what makes it
  // legible that the box can be stretched in TIME as well as in price.
  if (env.labels) {
    line(env, x1, top, x1, bottom, withAlpha(color, 0.55), 1, null);
    line(env, x2, top, x2, bottom, withAlpha(color, 0.55), 1, null);
  }

  // Level readouts, inside the box at its left edge. Dropped on a box too
  // narrow to hold them rather than spilling over the candles.
  if (Math.abs(x2 - x1) >= MIN_CHIP_SPAN_PX) {
    const chipX = Math.min(x1, x2) + 4;
    drawChip(
      env,
      `TP +${pips(metrics.rewardPips)}p`,
      chipX,
      yTarget,
      withAlpha(REWARD_COLOR, LABEL_BG_ALPHA),
      LABEL_TEXT,
    );
    drawChip(
      env,
      `${drawing.side.toUpperCase()}  ${rr}R`,
      chipX,
      yEntry,
      withAlpha(color, LABEL_BG_ALPHA),
      LABEL_TEXT,
    );
    drawChip(
      env,
      `SL −${pips(metrics.riskPips)}p`,
      chipX,
      yStop,
      withAlpha(RISK_COLOR, LABEL_BG_ALPHA),
      LABEL_TEXT,
    );
  }

  drawLabel(
    env,
    [
      `${drawing.side.toUpperCase()}  R:R ${rr}`,
      `RISK    ${pips(metrics.riskPips)} pips  ${usd(metrics.riskUsd)}`,
      `REWARD  ${pips(metrics.rewardPips)} pips  ${usd(metrics.rewardUsd)}`,
      `SPAN    ${utcMinute(drawing.time)} → ${utcMinute(drawing.endTime)}`,
    ],
    Math.max(x1, x2) + 6,
    top,
    { bg: withAlpha(color, LABEL_BG_ALPHA), accent: color },
  );
}

/* ---------- renderer ---------- */

class DrawingsRenderer implements IPrimitivePaneRenderer {
  private readonly _source: DrawingsPrimitive;

  public constructor(source: DrawingsPrimitive) {
    this._source = source;
  }

  public draw(target: RenderTarget): void {
    const source = this._source;
    const chart = source.chart;
    const series = source.series;
    if (chart === null || series === null) return;
    const state = source.state;
    if (state.drawings.length === 0 && state.draft === null) return;

    const coords = new Coords(chart, series);

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const env: Env = {
        ctx,
        hr: scope.horizontalPixelRatio,
        vr: scope.verticalPixelRatio,
        w: scope.mediaSize.width,
        h: scope.mediaSize.height,
        bw: scope.bitmapSize.width,
        bh: scope.bitmapSize.height,
        coords,
        // Set per drawing below; only the selection and the draft get labels.
        labels: false,
        placed: [],
      };
      source.noteSize(env.w, env.h);

      ctx.save();
      for (const drawing of state.drawings) {
        const emphasis: Emphasis =
          drawing.id === state.selectedId
            ? 'selected'
            : drawing.id === state.hoverId
              ? 'hover'
              : 'none';
        ctx.save();
        if (emphasis === 'hover') {
          ctx.shadowBlur = HOVER_GLOW * env.vr;
          ctx.shadowColor = withAlpha(drawing.style.color, 0.9);
        }
        env.labels = emphasis === 'selected';
        this._drawOne(env, drawing, emphasis, null);
        ctx.restore();
        if (emphasis === 'selected') {
          const points = source.projectOne(drawing, coords, env.w, env.h);
          // `handlePositions` is the single source of truth for where handles
          // are — it returns [] for an hline / vline, which is why none is
          // drawn there.
          if (points !== null) drawHandles(env, handlePositions({ drawing, points }));
        }
      }

      if (state.draft !== null) {
        // The draft always labels: while placing a position you need to see
        // the R:R you are about to commit.
        env.labels = true;
        this._drawDraft(env, state.draft);
      }
      ctx.restore();
    });
  }

  private _drawOne(env: Env, drawing: Drawing, emphasis: Emphasis, dash: Dash): void {
    const color = drawing.style.color || DEFAULT_STYLE.color;
    const width = widthFor(drawing.style.width, emphasis);
    const c = env.coords;

    switch (drawing.kind) {
      case 'trendline': {
        const a = c.toPoint(drawing.a);
        const b = c.toPoint(drawing.b);
        if (a === null || b === null) return;
        drawTrendline(env, a, b, color, width, dash);
        return;
      }
      case 'hline': {
        const y = c.yForPrice(drawing.price);
        if (y === null) return;
        drawHLine(env, y, drawing.price, color, width, dash);
        return;
      }
      case 'vline': {
        const x = c.xForTime(drawing.time);
        if (x === null) return;
        drawVLine(env, x, drawing.time, color, width, dash);
        return;
      }
      case 'rect': {
        const a = c.toPoint(drawing.a);
        const b = c.toPoint(drawing.b);
        if (a === null || b === null) return;
        drawRect(env, a, b, color, width, dash);
        return;
      }
      case 'fib': {
        const x1 = c.xForTime(drawing.a.time);
        const x2 = c.xForTime(drawing.b.time);
        if (x1 === null || x2 === null) return;
        if (Math.abs(x2 - x1) < MIN_LABEL_SPAN_PX) env.labels = false;
        drawFib(env, drawing.a, drawing.b, x1, x2, color, width, dash);
        return;
      }
      case 'position': {
        const x1 = c.xForTime(drawing.time);
        const x2 = c.xForTime(drawing.endTime);
        if (x1 === null || x2 === null) return;
        const yEntry = c.yForPrice(drawing.entry);
        const yStop = c.yForPrice(drawing.stop);
        const yTarget = c.yForPrice(drawing.target);
        if (yEntry === null || yStop === null || yTarget === null) return;
        if (Math.abs(x2 - x1) < MIN_LABEL_SPAN_PX) env.labels = false;
        drawPosition(env, drawing, x1, x2, yEntry, yStop, yTarget, color, width, dash);
        return;
      }
    }
  }

  /**
   * The in-progress placement: a dashed, semi-transparent rubber band from the
   * placed points to the live cursor. With no cursor yet, only the placed
   * points are marked. A one-click tool (hline / vline) has no placed points
   * before it commits, so its preview is just the cursor: a dashed line at the
   * pointer's y (or x) that follows the mouse until the click.
   *
   * The preview shape is built with `drawingFromDraft` from
   * `placed + cursor`, so the rubber band is byte-for-byte the drawing that
   * will be committed — the preview can never disagree with the result.
   */
  private _drawDraft(env: Env, draft: Draft): void {
    const color = DEFAULT_STYLE.color;
    const c = env.coords;

    const placed: Pt[] = [];
    for (const anchor of draft.points) {
      const p = c.toPoint(anchor);
      if (p !== null) placed.push(p);
    }

    env.ctx.save();
    env.ctx.globalAlpha = DRAFT_ALPHA;

    const points = draft.cursor === null ? draft.points : [...draft.points, draft.cursor];
    const preview = drawingFromDraft(
      { tool: draft.tool, points, cursor: null },
      DRAFT_ID,
      DEFAULT_STYLE,
    );
    if (preview !== null) this._drawOne(env, preview, 'none', DRAFT_DASH);

    for (const p of placed) drawDraftPoint(env, p, color);
    env.ctx.restore();
  }
}

class DrawingsPaneView implements IPrimitivePaneView {
  private readonly _source: DrawingsPrimitive;
  private readonly _renderer: DrawingsRenderer;

  public constructor(source: DrawingsPrimitive) {
    this._source = source;
    this._renderer = new DrawingsRenderer(source);
  }

  /** Above the series. */
  public zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  /** Nothing to draw costs nothing. */
  public renderer(): IPrimitivePaneRenderer | null {
    const state = this._source.state;
    if (state.drawings.length === 0 && state.draft === null) return null;
    return this._renderer;
  }
}

/* ---------- the primitive ---------- */

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  public state: DrawingsViewState = EMPTY_VIEW_STATE;
  public chart: IChartApiBase<Time> | null = null;
  public series: ISeriesApi<SeriesType, Time> | null = null;

  /**
   * The array identity must be stable: the library caches pane views by
   * reference and rebuilds its internal state whenever a new array appears.
   */
  private readonly _paneViews: readonly IPrimitivePaneView[];
  private _requestUpdate: (() => void) | null = null;
  /**
   * Last painted media size, so `project` can give an `hline` (or a `vline`)
   * the same synthetic x (or y) the renderer would use for its handle.
   */
  private _lastWidth: number | null = null;
  private _lastHeight: number | null = null;

  public constructor() {
    this._paneViews = [new DrawingsPaneView(this)];
  }

  public attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart;
    this.series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  public detached(): void {
    this.chart = null;
    this.series = null;
    this._requestUpdate = null;
    this._lastWidth = null;
    this._lastHeight = null;
  }

  public paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  /** Geometry is derived at draw time from live coordinates, so this is a no-op. */
  public updateAllViews(): void {}

  /** Swap the view state in place and repaint — never re-attach a new primitive. */
  public setState(state: DrawingsViewState): void {
    this.state = state;
    this._requestUpdate?.();
  }

  /** Called by the renderer so `project` and `draw` agree on the canvas size. */
  public noteSize(width: number, height: number): void {
    if (Number.isFinite(width)) this._lastWidth = width;
    if (Number.isFinite(height)) this._lastHeight = height;
  }

  /**
   * Screen-space projection of the given drawings, for hit-testing.
   * Returns null before the primitive is attached. A drawing whose anchors
   * cannot be converted is omitted — it is not on screen, so it is not hittable.
   */
  public project(drawings: Drawing[]): Projected[] | null {
    const coords = this._coords();
    if (coords === null) return null;
    const width = this._width();
    const height = this._height();
    const out: Projected[] = [];
    for (const drawing of drawings) {
      const points = this.projectOne(drawing, coords, width, height);
      if (points !== null) out.push({ drawing, points });
    }
    return out;
  }

  /**
   * One drawing's handle points, in the frozen order documented at the top of
   * this file. Null when any anchor is unconvertible.
   */
  public projectOne(
    drawing: Drawing,
    coords: Coords,
    width: number,
    height: number,
  ): Pt[] | null {
    switch (drawing.kind) {
      case 'trendline':
      case 'rect':
      case 'fib': {
        const a = coords.toPoint(drawing.a);
        const b = coords.toPoint(drawing.b);
        return a === null || b === null ? null : [a, b];
      }
      case 'hline': {
        const y = coords.yForPrice(drawing.price);
        // `x` is meaningless for an hline (it spans the width); the canvas
        // centre keeps the selection handle somewhere sane.
        return y === null ? null : [{ x: width / 2, y }];
      }
      case 'vline': {
        const x = coords.xForTime(drawing.time);
        // `y` is meaningless for a vline (it spans the height); the canvas
        // centre keeps the handle math sane, exactly as hline uses `width / 2`.
        return x === null ? null : [{ x, y: height / 2 }];
      }
      case 'position': {
        const x1 = coords.xForTime(drawing.time);
        const x2 = coords.xForTime(drawing.endTime);
        if (x1 === null || x2 === null) return null;
        const yEntry = coords.yForPrice(drawing.entry);
        const yStop = coords.yForPrice(drawing.stop);
        const yTarget = coords.yForPrice(drawing.target);
        if (yEntry === null || yStop === null || yTarget === null) return null;
        // geometry.ts's convention: entry at the LEFT edge, stop/target at
        // the RIGHT edge. `hitTest` takes the band's span as min..max of these.
        // The last two are the width handles, parked at the vertical middle of
        // the box so they cannot sit on top of a level handle.
        const midY = (Math.min(yEntry, yStop, yTarget) + Math.max(yEntry, yStop, yTarget)) / 2;
        return [
          { x: x1, y: yEntry },
          { x: x2, y: yStop },
          { x: x2, y: yTarget },
          { x: x1, y: midY },
          { x: x2, y: midY },
        ];
      }
    }
  }

  /** Pixel point -> chart space, for placing and dragging. */
  public toAnchor(p: Pt): Anchor | null {
    const coords = this._coords();
    return coords === null ? null : coords.toAnchor(p);
  }

  /** Chart space -> pixel point. */
  public toPoint(a: Anchor): Pt | null {
    const coords = this._coords();
    return coords === null ? null : coords.toPoint(a);
  }

  private _coords(): Coords | null {
    if (this.chart === null || this.series === null) return null;
    return new Coords(this.chart, this.series);
  }

  private _width(): number {
    if (this._lastWidth !== null) return this._lastWidth;
    if (this.chart === null) return 0;
    const w = this.chart.timeScale().width();
    return Number.isFinite(w) ? w : 0;
  }

  private _height(): number {
    if (this._lastHeight !== null) return this._lastHeight;
    if (this.chart === null) return 0;
    try {
      const h = this.chart.paneSize().height;
      return Number.isFinite(h) ? h : 0;
    } catch {
      return 0;
    }
  }
}
