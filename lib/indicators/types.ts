/**
 * Contract for the "Big Body Candle Border + Retest" indicator.
 *
 * This is a FAITHFUL port of the user's Pine Script v6 indicator. Where a
 * Pine behaviour looks odd, it is reproduced deliberately and the quirk is
 * documented — do not "fix" it.
 *
 * Geometry is computed server-side over the WHOLE series, never over a page:
 * a level's fate depends on bars after the one that created it, so computing
 * over a 3000-bar window would mislabel levels whose touch bar is off-window.
 * Big candles are sparse (871 on H1 at the default threshold, out of 29,534
 * bars), so the entire shape set ships in one response.
 */

import type { Timeframe } from '@/lib/candles/types';

/** Pine: `levelMode` input options, verbatim. */
export const LEVEL_MODES = [
  'Impulse origin (auto)',
  'High & Low',
  'High',
  'Low',
  'Close',
  'Open',
] as const;

export type LevelMode = (typeof LEVEL_MODES)[number];

export function isLevelMode(value: string): value is LevelMode {
  return (LEVEL_MODES as readonly string[]).includes(value);
}

/**
 * How "big" is decided.
 *
 * `pips` is Pine's own rule and stays the default, so nothing you already have
 * changes. The other two exist because a FIXED threshold does not survive a
 * price regime: gold ran 1800 -> 4400 over this data, so a $20 body was 1.12%
 * of price in 2021 and 0.44% in 2026. Measured consequence — H1 big candles
 * per year at $20: 3, 16, 13, 30, 222, 587. Two thirds of the sample lands in
 * the final year, which makes a five-year backtest a one-year backtest wearing
 * a disguise.
 *
 *  - `pips`    body / pipSize >= thresholdPips            (Pine-faithful)
 *  - `percent` body >= thresholdPercent% of the bar close (scale-free)
 *  - `atr`     body >= atrMultiple x ATR(atrPeriod)       (volatility-relative)
 */
export type ThresholdMode = 'pips' | 'percent' | 'atr';

export const THRESHOLD_MODES: readonly ThresholdMode[] = ['pips', 'percent', 'atr'];

export function isThresholdMode(v: string): v is ThresholdMode {
  return (THRESHOLD_MODES as readonly string[]).includes(v);
}

/**
 * Pine inputs, same names and same defaults.
 * Presentation-only inputs (colors) are NOT here: they stay client-side, so
 * the computation is pure geometry. See `SegmentState` for how `showPending`
 * is applied without leaking colour into the compute layer.
 */
export interface BigBodyParams {
  /** Which rule decides "big". Default `pips` keeps Pine's behaviour. */
  thresholdMode: ThresholdMode;
  /** Pine `thresholdPips`, default 2000. Body size in pips. Mode `pips`. */
  thresholdPips: number;
  /** Percent of the bar's close, e.g. 0.5 means 0.5%. Mode `percent`. */
  thresholdPercent: number;
  /** Wilder ATR lookback. Mode `atr`. */
  atrPeriod: number;
  /** Body must reach this multiple of ATR. Mode `atr`. */
  atrMultiple: number;
  /** Pine `autoPip`, default false. When true, pipSize = mintick * 10. */
  autoPip: boolean;
  /** Pine `manualPip`, default 0.01. */
  manualPip: number;
  /** Pine `frameFull`, default true. Box spans high..low instead of the body. */
  frameFull: boolean;
  /** Pine `showLabel`, default true. */
  showLabel: boolean;
  /** Pine `levelMode`, default 'Impulse origin (auto)'. */
  levelMode: LevelMode;
  /** Pine `maxDays`, default 1. Level expires when dayId delta EXCEEDS this. */
  maxDays: number;
  /** Pine `minGap`, default 1. Bars that must elapse before a touch counts. */
  minGap: number;
}

export const DEFAULT_BIG_BODY_PARAMS: BigBodyParams = {
  thresholdMode: 'pips',
  thresholdPips: 2000,
  thresholdPercent: 0.5,
  atrPeriod: 14,
  atrMultiple: 1,
  autoPip: false,
  manualPip: 0.01,
  frameFull: true,
  showLabel: true,
  levelMode: 'Impulse origin (auto)',
  maxDays: 1,
  minGap: 1,
};

/**
 * Pine `syminfo.mintick`. XAUUSDm quotes to 3 decimals, so 0.001.
 * With `autoPip`, pipSize becomes 0.01 — identical to the manual default,
 * so both settings agree on this symbol.
 */
export const XAUUSD_MINTICK = 0.001;

/**
 * Pine draws a `box` per big candle.
 * `time` is the bar's own timestamp; `endTime` is Pine's `time_close`, which
 * we derive as the NEXT bar's time — never time + N minutes, because the
 * series has weekend (~49h) and daily (~63min) gaps and a fixed duration
 * would draw into dead space. The final bar falls back to a nominal width.
 */
export interface BoxShape {
  time: number;
  endTime: number;
  top: number;
  bottom: number;
}

/** Pine `label.new(..., style = label.style_label_down)` anchored at the box top. */
export interface LabelShape {
  time: number;
  price: number;
  /** Pine: `str.tostring(math.round(bodyPips)) + " pips"`. */
  text: string;
}

/**
 * How a level ended. The client maps this to Pine's colours:
 *   pending -> showPending ? pendingCol : transparent
 *   touched -> touchedCol (ALWAYS visible)
 *   expired -> showPending ? pendingCol : transparent
 *
 * Pine quirk, reproduced on purpose: with `showPending = false` a pending
 * line is created fully transparent, but `line.set_color(touchedCol)` on a
 * touch makes it visible. So hiding pending lines still reveals touched ones.
 */
export type SegmentState = 'pending' | 'touched' | 'expired';

/**
 * Pine `line` tracking one level.
 *
 * Pine quirk, reproduced on purpose: an UNRESOLVED level is extended to the
 * current bar's `time_close` each bar, but on resolution `line.set_x2` is
 * called with `time` — the bar's OPEN. So a resolved segment ends one bar
 * width earlier than a still-pending one.
 */
export interface SegmentShape {
  time: number;
  endTime: number;
  price: number;
  state: SegmentState;
}

export interface BigBodyStats {
  totalBars: number;
  bigCandles: number;
  levelsCreated: number;
  touched: number;
  expired: number;
  /** Still unresolved when the series ended. */
  pending: number;
  /** True when Pine's 500-object cap dropped older shapes. */
  truncated: boolean;
}

export interface BigBodyResult {
  timeframe: Timeframe;
  params: BigBodyParams;
  boxes: BoxShape[];
  labels: LabelShape[];
  segments: SegmentShape[];
  stats: BigBodyStats;
}

/**
 * Pine `indicator(..., max_boxes_count = 500, max_lines_count = 500,
 * max_labels_count = 500)`. Pine silently deletes the OLDEST objects past
 * this cap, so only the most recent 500 of each are ever visible. Faithful
 * ports must do the same: H1 produces 871 boxes, of which Pine shows 500.
 */
export const PINE_MAX_OBJECTS = 500;


/* ---------- Level lifecycle (for the strategy tester) ---------- */

/**
 * One level's whole life, as DATA rather than as drawing geometry.
 *
 * `computeBigBody` emits shapes for the renderer; the backtest needs the same
 * state machine's decisions in a machine-readable form — which impulse created
 * the level, which way it pointed, and exactly which bar touched it.
 *
 * Two differences from the shape output, both deliberate:
 *  - Level events are NEVER capped. Pine's 500-object limit is a drawing
 *    constraint; a backtest that silently ignored 371 of 871 H1 levels would
 *    report a different strategy from the one you asked about.
 *  - Indices are included, so the simulator can walk forward from the touch
 *    without re-deriving anything.
 */
export interface LevelEvent {
  /** The level's price. */
  price: number;
  /**
   * Trade direction on a retest, taken WITH the impulse: a bullish impulse
   * leaves its level at the low (buy the dip), a bearish one at the high.
   */
  side: 'long' | 'short';
  /** Index/time of the impulse candle that created the level. */
  createdIndex: number;
  createdTime: number;
  /** |close - open| of the impulse candle; the basis for the 1R stop. */
  impulseBody: number;
  outcome: SegmentState;
  /** Set only when `outcome === 'touched'`. */
  touchedIndex?: number;
  touchedTime?: number;
}
