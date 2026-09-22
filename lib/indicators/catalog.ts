/**
 * The indicator catalog: what the user can add to a chart, and how to compute it.
 *
 * Deliberately free of any `lightweight-charts` import. Everything here is data
 * and pure functions, so the whole catalog is unit-testable in plain node and a
 * future server-side or worker-side computation needs no rewrite. Turning a
 * result into chart series is the job of `useChartIndicators`.
 *
 * ## Definitions vs instances
 *
 * A DEFINITION (`IndicatorDef`) is the immutable description of an indicator:
 * its inputs, its plots, its default colours. An INSTANCE
 * (`IndicatorInstance`) is one copy the user has added, with their chosen
 * period and colours. That split is what lets someone stack EMA 20, EMA 50 and
 * EMA 200 as three independent rows.
 */

import type { Bar } from '@/lib/candles/types';
import {
  adx,
  atr,
  bollinger,
  ema,
  hma,
  macd,
  rsi,
  sma,
  stochastic,
  supertrend,
  vwap,
  wma,
} from './ta';

/* ------------------------------------------------------------------ */
/* Price source                                                        */
/* ------------------------------------------------------------------ */

export const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<Source, string> = {
  close: 'Close',
  open: 'Open',
  high: 'High',
  low: 'Low',
  hl2: 'HL/2',
  hlc3: 'HLC/3',
  ohlc4: 'OHLC/4',
};

/** Columnar view of a page of bars, built once and shared by every indicator. */
export interface BarColumns {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  length: number;
}

export function toColumns(bars: readonly Bar[]): BarColumns {
  const n = bars.length;
  const columns: BarColumns = {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
    length: n,
  };
  for (let i = 0; i < n; i += 1) {
    const bar = bars[i];
    columns.time[i] = bar.time;
    columns.open[i] = bar.open;
    columns.high[i] = bar.high;
    columns.low[i] = bar.low;
    columns.close[i] = bar.close;
    columns.volume[i] = bar.volume;
  }
  return columns;
}

export function sourceValues(columns: BarColumns, source: Source): Float64Array {
  const n = columns.length;
  switch (source) {
    case 'open':
      return columns.open;
    case 'high':
      return columns.high;
    case 'low':
      return columns.low;
    case 'close':
      return columns.close;
    case 'hl2': {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i += 1) out[i] = (columns.high[i] + columns.low[i]) / 2;
      return out;
    }
    case 'hlc3': {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        out[i] = (columns.high[i] + columns.low[i] + columns.close[i]) / 3;
      }
      return out;
    }
    case 'ohlc4': {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        out[i] =
          (columns.open[i] + columns.high[i] + columns.low[i] + columns.close[i]) / 4;
      }
      return out;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

export const INDICATOR_IDS = [
  'ema', 'sma', 'wma', 'hma', 'bb', 'vwap', 'supertrend',
  'rsi', 'macd', 'stoch', 'atr', 'adx',
] as const;
export type IndicatorId = (typeof INDICATOR_IDS)[number];

export function isIndicatorId(value: string): value is IndicatorId {
  return (INDICATOR_IDS as readonly string[]).includes(value);
}

/** A numeric input, rendered as a labelled stepper. */
export interface NumberInput {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  fallback: number;
}

export type PlotStyle = 'line' | 'histogram' | 'dashed';

export interface PlotDef {
  key: string;
  label: string;
  style: PlotStyle;
  color: string;
}

/** A static horizontal reference, e.g. RSI's 30 and 70. */
export interface LevelDef {
  value: number;
  color: string;
}

export interface IndicatorDef {
  id: IndicatorId;
  label: string;
  /** What the legend prints, before the parameters. */
  short: string;
  /** One line explaining what it is FOR — shown in the picker. */
  hint: string;
  /**
   * `price` draws on the candle pane in price units. `separate` gets its own
   * pane, because an RSI between 0 and 100 plotted against gold at 4378 would
   * flatten the candles into a line.
   */
  pane: 'price' | 'separate';
  inputs: NumberInput[];
  /** Whether the user may pick which price this is computed from. */
  hasSource: boolean;
  defaultSource: Source;
  plots: PlotDef[];
  levels?: LevelDef[];
  /** Fixes the pane's scale so the oscillator does not auto-zoom on noise. */
  fixedRange?: { min: number; max: number };
  /** Decimals in the legend. Price-pane indicators follow the chart instead. */
  precision?: number;
  compute(columns: BarColumns, params: Record<string, number>, source: Source):
    Record<string, Float64Array>;
}

/* A palette with enough separation to stay readable when four are stacked. */
const GOLD = '#e8b339';
const CYAN = '#38bdf8';
const VIOLET = '#a78bfa';
const LIME = '#a3e635';
const ORANGE = '#fb923c';
const PINK = '#f472b6';
const TEAL = '#2dd4bf';
const SLATE = '#64748b';

function lengthInput(fallback: number, label = 'Length'): NumberInput {
  return { key: 'length', label, min: 1, max: 1000, step: 1, fallback };
}

/** Reads a param, falling back to the definition's default when absent or unusable. */
export function paramOf(
  def: IndicatorDef,
  params: Record<string, number>,
  key: string,
): number {
  const input = def.inputs.find((candidate) => candidate.key === key);
  const fallback = input?.fallback ?? 0;
  const raw = params[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  if (input === undefined) return raw;
  // Clamp rather than reject: a stored param from an older build with a wider
  // range should still draw something sensible.
  return Math.min(input.max, Math.max(input.min, raw));
}

const DEFS: Record<IndicatorId, IndicatorDef> = {
  ema: {
    id: 'ema',
    label: 'EMA',
    short: 'EMA',
    hint: 'Exponential moving average — reacts faster than the SMA to new prices.',
    pane: 'price',
    inputs: [lengthInput(21)],
    hasSource: true,
    defaultSource: 'close',
    plots: [{ key: 'ema', label: 'EMA', style: 'line', color: GOLD }],
    compute: (columns, params, source) => ({
      ema: ema(sourceValues(columns, source), paramOf(DEFS.ema, params, 'length')),
    }),
  },

  sma: {
    id: 'sma',
    label: 'SMA',
    short: 'SMA',
    hint: 'Simple moving average — every bar in the window weighted equally.',
    pane: 'price',
    inputs: [lengthInput(50)],
    hasSource: true,
    defaultSource: 'close',
    plots: [{ key: 'sma', label: 'SMA', style: 'line', color: CYAN }],
    compute: (columns, params, source) => ({
      sma: sma(sourceValues(columns, source), paramOf(DEFS.sma, params, 'length')),
    }),
  },

  wma: {
    id: 'wma',
    label: 'WMA',
    short: 'WMA',
    hint: 'Weighted moving average — a linear ramp of weights toward the newest bar.',
    pane: 'price',
    inputs: [lengthInput(20)],
    hasSource: true,
    defaultSource: 'close',
    plots: [{ key: 'wma', label: 'WMA', style: 'line', color: VIOLET }],
    compute: (columns, params, source) => ({
      wma: wma(sourceValues(columns, source), paramOf(DEFS.wma, params, 'length')),
    }),
  },

  hma: {
    id: 'hma',
    label: 'Hull MA',
    short: 'HMA',
    hint: 'Hull moving average — much less lag than an EMA, at the cost of overshoot.',
    pane: 'price',
    inputs: [lengthInput(21)],
    hasSource: true,
    defaultSource: 'close',
    plots: [{ key: 'hma', label: 'HMA', style: 'line', color: LIME }],
    compute: (columns, params, source) => ({
      hma: hma(sourceValues(columns, source), paramOf(DEFS.hma, params, 'length')),
    }),
  },

  bb: {
    id: 'bb',
    label: 'Bollinger Bands',
    short: 'BB',
    hint: 'An SMA with standard-deviation envelopes — a volatility range, not a signal.',
    pane: 'price',
    inputs: [
      lengthInput(20),
      { key: 'multiplier', label: 'StdDev', min: 0.1, max: 10, step: 0.1, fallback: 2 },
    ],
    hasSource: true,
    defaultSource: 'close',
    plots: [
      { key: 'upper', label: 'Upper', style: 'line', color: CYAN },
      { key: 'middle', label: 'Basis', style: 'dashed', color: SLATE },
      { key: 'lower', label: 'Lower', style: 'line', color: CYAN },
    ],
    compute: (columns, params, source) =>
      bollinger(
        sourceValues(columns, source),
        paramOf(DEFS.bb, params, 'length'),
        paramOf(DEFS.bb, params, 'multiplier'),
      ) as unknown as Record<string, Float64Array>,
  },

  vwap: {
    id: 'vwap',
    label: 'VWAP (daily)',
    short: 'VWAP',
    hint: 'Volume-weighted average price, reset each server day — the session fair value.',
    pane: 'price',
    inputs: [],
    hasSource: false,
    defaultSource: 'hlc3',
    plots: [{ key: 'vwap', label: 'VWAP', style: 'line', color: ORANGE }],
    compute: (columns) => ({
      vwap: vwap(columns.time, columns.high, columns.low, columns.close, columns.volume),
    }),
  },

  supertrend: {
    id: 'supertrend',
    label: 'SuperTrend',
    short: 'ST',
    hint: 'An ATR-banded trailing stop that flips with the trend.',
    pane: 'price',
    inputs: [
      { key: 'length', label: 'ATR Length', min: 1, max: 200, step: 1, fallback: 10 },
      { key: 'factor', label: 'Factor', min: 0.1, max: 20, step: 0.1, fallback: 3 },
    ],
    hasSource: false,
    defaultSource: 'close',
    plots: [{ key: 'line', label: 'SuperTrend', style: 'line', color: TEAL }],
    compute: (columns, params) => {
      const result = supertrend(
        columns.high,
        columns.low,
        columns.close,
        paramOf(DEFS.supertrend, params, 'length'),
        paramOf(DEFS.supertrend, params, 'factor'),
      );
      return { line: result.line, direction: result.direction };
    },
  },

  rsi: {
    id: 'rsi',
    label: 'RSI',
    short: 'RSI',
    hint: 'Relative Strength Index — momentum on a 0-100 scale.',
    pane: 'separate',
    inputs: [lengthInput(14)],
    hasSource: true,
    defaultSource: 'close',
    plots: [{ key: 'rsi', label: 'RSI', style: 'line', color: VIOLET }],
    levels: [
      { value: 70, color: SLATE },
      { value: 50, color: '#2b3138' },
      { value: 30, color: SLATE },
    ],
    fixedRange: { min: 0, max: 100 },
    precision: 2,
    compute: (columns, params, source) => ({
      rsi: rsi(sourceValues(columns, source), paramOf(DEFS.rsi, params, 'length')),
    }),
  },

  macd: {
    id: 'macd',
    label: 'MACD',
    short: 'MACD',
    hint: 'The gap between two EMAs, its signal line, and the histogram between them.',
    pane: 'separate',
    inputs: [
      { key: 'fast', label: 'Fast', min: 1, max: 500, step: 1, fallback: 12 },
      { key: 'slow', label: 'Slow', min: 1, max: 500, step: 1, fallback: 26 },
      { key: 'signal', label: 'Signal', min: 1, max: 500, step: 1, fallback: 9 },
    ],
    hasSource: true,
    defaultSource: 'close',
    plots: [
      { key: 'histogram', label: 'Hist', style: 'histogram', color: SLATE },
      { key: 'macd', label: 'MACD', style: 'line', color: CYAN },
      { key: 'signal', label: 'Signal', style: 'line', color: ORANGE },
    ],
    levels: [{ value: 0, color: '#2b3138' }],
    precision: 3,
    compute: (columns, params, source) =>
      macd(
        sourceValues(columns, source),
        paramOf(DEFS.macd, params, 'fast'),
        paramOf(DEFS.macd, params, 'slow'),
        paramOf(DEFS.macd, params, 'signal'),
      ) as unknown as Record<string, Float64Array>,
  },

  stoch: {
    id: 'stoch',
    label: 'Stochastic',
    short: 'Stoch',
    hint: 'Where price closed inside its recent range, 0-100.',
    pane: 'separate',
    inputs: [
      { key: 'length', label: '%K Length', min: 1, max: 500, step: 1, fallback: 14 },
      { key: 'smoothK', label: '%K Smooth', min: 1, max: 100, step: 1, fallback: 3 },
      { key: 'smoothD', label: '%D Smooth', min: 1, max: 100, step: 1, fallback: 3 },
    ],
    hasSource: false,
    defaultSource: 'close',
    plots: [
      { key: 'k', label: '%K', style: 'line', color: CYAN },
      { key: 'd', label: '%D', style: 'line', color: ORANGE },
    ],
    levels: [
      { value: 80, color: SLATE },
      { value: 20, color: SLATE },
    ],
    fixedRange: { min: 0, max: 100 },
    precision: 2,
    compute: (columns, params) =>
      stochastic(
        columns.high,
        columns.low,
        columns.close,
        paramOf(DEFS.stoch, params, 'length'),
        paramOf(DEFS.stoch, params, 'smoothK'),
        paramOf(DEFS.stoch, params, 'smoothD'),
      ) as unknown as Record<string, Float64Array>,
  },

  atr: {
    id: 'atr',
    label: 'ATR',
    short: 'ATR',
    hint: 'Average True Range — how far this market moves per bar. Size stops with it.',
    pane: 'separate',
    inputs: [lengthInput(14)],
    hasSource: false,
    defaultSource: 'close',
    plots: [{ key: 'atr', label: 'ATR', style: 'line', color: GOLD }],
    precision: 3,
    compute: (columns, params) => ({
      atr: atr(
        columns.high,
        columns.low,
        columns.close,
        paramOf(DEFS.atr, params, 'length'),
      ),
    }),
  },

  adx: {
    id: 'adx',
    label: 'ADX / DMI',
    short: 'ADX',
    hint: 'Trend STRENGTH, not direction — direction is the +DI / -DI pair.',
    pane: 'separate',
    inputs: [lengthInput(14)],
    hasSource: false,
    defaultSource: 'close',
    plots: [
      { key: 'adx', label: 'ADX', style: 'line', color: GOLD },
      { key: 'plusDi', label: '+DI', style: 'line', color: TEAL },
      { key: 'minusDi', label: '-DI', style: 'line', color: PINK },
    ],
    levels: [{ value: 25, color: SLATE }],
    fixedRange: { min: 0, max: 100 },
    precision: 2,
    compute: (columns, params) =>
      adx(
        columns.high,
        columns.low,
        columns.close,
        paramOf(DEFS.adx, params, 'length'),
      ) as unknown as Record<string, Float64Array>,
  },
};

export const INDICATOR_DEFS: Readonly<Record<IndicatorId, IndicatorDef>> = DEFS;

export function indicatorDef(id: IndicatorId): IndicatorDef {
  return DEFS[id];
}

/** Picker order: overlays first, then oscillators — how a trader thinks of them. */
export const CATALOG_GROUPS: ReadonlyArray<{ label: string; ids: readonly IndicatorId[] }> = [
  { label: 'Overlays', ids: ['ema', 'sma', 'wma', 'hma', 'bb', 'vwap', 'supertrend'] },
  { label: 'Oscillators', ids: ['rsi', 'macd', 'stoch', 'atr', 'adx'] },
];

/* ------------------------------------------------------------------ */
/* Instances                                                           */
/* ------------------------------------------------------------------ */

export interface IndicatorInstance {
  /** Stable across re-renders and persisted; the chart keys its series on it. */
  instanceId: string;
  id: IndicatorId;
  /** Hidden instances keep their settings but draw nothing. */
  visible: boolean;
  params: Record<string, number>;
  source: Source;
  /** Plot key -> colour. Missing keys fall back to the definition's colour. */
  colors: Record<string, string>;
  lineWidth: number;
}

export const MAX_INDICATORS = 12;
export const DEFAULT_LINE_WIDTH = 2;

let counter = 0;

/** Unique enough for a client-side list; never persisted as a cross-session key. */
function newInstanceId(id: IndicatorId): string {
  counter += 1;
  return `${id}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function createInstance(id: IndicatorId): IndicatorInstance {
  const def = DEFS[id];
  const params: Record<string, number> = {};
  for (const input of def.inputs) params[input.key] = input.fallback;
  const colors: Record<string, string> = {};
  for (const plot of def.plots) colors[plot.key] = plot.color;
  return {
    instanceId: newInstanceId(id),
    id,
    visible: true,
    params,
    source: def.defaultSource,
    colors,
    lineWidth: DEFAULT_LINE_WIDTH,
  };
}

/** The legend label: `EMA 21` / `MACD 12 26 9` / `BB 20 2`. */
export function instanceLabel(instance: IndicatorInstance): string {
  const def = DEFS[instance.id];
  if (def.inputs.length === 0) return def.short;
  const values = def.inputs.map((input) => {
    const value = paramOf(def, instance.params, input.key);
    // Trim a trailing `.0` so `BB 20 2` does not read `BB 20 2.0`.
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  });
  return `${def.short} ${values.join(' ')}`;
}

export function colorOf(instance: IndicatorInstance, plot: PlotDef): string {
  const chosen = instance.colors[plot.key];
  return typeof chosen === 'string' && chosen.length > 0 ? chosen : plot.color;
}

/**
 * Compute one instance.
 *
 * Returns an empty record rather than throwing when there is not enough data:
 * a 200-period EMA on a 50-bar page is a legitimate thing for the user to ask
 * for, and the honest answer is "no values yet", not an error dialog.
 */
export function computeInstance(
  instance: IndicatorInstance,
  columns: BarColumns,
): Record<string, Float64Array> {
  const def = DEFS[instance.id];
  if (columns.length === 0) return {};
  const source = def.hasSource ? instance.source : def.defaultSource;
  return def.compute(columns, instance.params, source);
}
