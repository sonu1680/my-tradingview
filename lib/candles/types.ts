/**
 * Shared contract for the in-memory candle store.
 *
 * Source data: MetaTrader 5 CSV exports of XAUUSDm, 21 timeframes, 2021-09 -> 2026-09.
 * Columns: time,open,high,low,close,tick_volume,spread,real_volume
 * Timestamps are broker SERVER time, format `YYYY.MM.DD HH:MM`, with no timezone.
 * We never shift them; the UI labels the axis "server time".
 */

export const TIMEFRAMES = [
  'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M10', 'M12', 'M15', 'M20', 'M30',
  'H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12',
  'D1', 'W1', 'MN1',
] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

/** Minutes per bar, used only for labels/sorting — not for gap filling. */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  M1: 1, M2: 2, M3: 3, M4: 4, M5: 5, M6: 6, M10: 10, M12: 12,
  M15: 15, M20: 20, M30: 30,
  H1: 60, H2: 120, H3: 180, H4: 240, H6: 360, H8: 480, H12: 720,
  D1: 1440, W1: 10080, MN1: 43200,
};

/**
 * Columnar storage. One entry per loaded timeframe.
 *
 * Arrays-of-objects would cost ~350MB and heavy GC pressure for M1's 1.76M bars;
 * columnar typed arrays cost ~40 bytes/bar with zero GC churn.
 * Prices stay Float64: gold at 4378.577 needs 7 significant digits, which is
 * right at Float32's precision limit.
 */
export interface CandleSeries {
  readonly timeframe: Timeframe;
  /** Unix seconds, ascending, no duplicates. */
  readonly time: Int32Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  /** MT5 tick_volume. */
  readonly volume: Int32Array;
  /**
   * MT5 spread in POINTS, where 1 point = 0.001 in price for this symbol
   * (verified: every OHLC value in the exports is an exact multiple of 0.001).
   * So the H1 mean of ~197 points is $0.197.
   *
   * Kept because the backtest charges it as a real cost; dropping it would
   * make every strategy look better than it is. Costs 4 bytes/bar — 7 MB on
   * M1's 1.76M rows.
   */
  readonly spread: Int32Array;
  readonly count: number;
  /** Rows skipped during parsing because they were malformed. */
  readonly skippedRows: number;
}

/** One candle as the API and chart consume it. `time` is unix seconds. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A page of bars, ordered oldest -> newest.
 *
 * Three ways to ask for one, mutually exclusive:
 *  - `before=<index>`  the `limit` bars ending just before that index (scroll-back)
 *  - `until=<time>`    the `limit` bars ending at the last bar whose time <= until
 *                      — the tail of the series "as of that moment", for bar replay
 *  - `after=<index>`   the `limit` bars starting just after that index (stepping
 *                      forward in replay)
 * With none of them: the most recent `limit` bars.
 */
export interface CandlePage {
  timeframe: Timeframe;
  bars: Bar[];
  /**
   * Index in the full series of `bars[0]`. Zero means the caller has reached
   * the oldest bar and must stop requesting older pages.
   */
  startIndex: number;
  /** Total bars available in this timeframe. */
  totalBars: number;
  /** True when startIndex > 0, i.e. older bars exist. */
  hasMore: boolean;
  /**
   * True when bars exist AFTER the last one returned, i.e.
   * `startIndex + bars.length < totalBars`. Replay stops stepping when false.
   */
  hasNewer: boolean;
}

/** Summary of one timeframe, for the timeframe bar and the empty state. */
export interface TimeframeInfo {
  timeframe: Timeframe;
  /** Null when the CSV for this timeframe is absent. */
  totalBars: number | null;
  /** Unix seconds of the first and last bar; null when absent. */
  firstTime: number | null;
  lastTime: number | null;
  loaded: boolean;
}

export const SYMBOL = 'XAUUSDm';
export const DEFAULT_PAGE_SIZE = 3000;
export const MAX_PAGE_SIZE = 20000;
