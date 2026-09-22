/**
 * Technical-analysis primitives.
 *
 * Every function here is pure, allocation-light and operates on `ArrayLike<number>`
 * so it can be fed either a plain `number[]` from an API page or a `Float64Array`
 * column straight out of the candle store.
 *
 * ## The NaN contract
 *
 * A bar with no defined value — the warm-up window of an EMA, the first bar of a
 * true range — is `NaN`, never `0` and never a silently repeated previous value.
 * Zero is a legitimate indicator reading (RSI can print it, MACD crosses it) and
 * forward-filling would draw a flat line the market never made. Callers must skip
 * non-finite entries when building chart data; `toLineData` in `catalog.ts` does.
 *
 * ## Fidelity to Pine
 *
 * These mirror TradingView's built-ins so a level read here is the level the user
 * would read there:
 *  - `ema` seeds from an SMA of the first `period` values (Pine's `ta.ema`).
 *  - `rma` is Wilder's smoothing, also SMA-seeded (Pine's `ta.rma`), and is what
 *    RSI, ATR and ADX are built on — NOT a plain EMA, which is the single most
 *    common way these get subtly wrong.
 *  - `stdev` is the POPULATION deviation (divide by n), matching `ta.stdev`, not
 *    the sample deviation (n-1).
 *
 * ## Warm-up on a paged dataset
 *
 * The chart holds a page of bars, not all of history, so a recursive average
 * (`ema`, `rma`) is seeded from the start of the PAGE rather than the start of
 * the symbol. The error decays geometrically: after roughly 5x the period it is
 * below float noise. With 3000-bar pages and periods <= 200 the visible tail is
 * exact; only the far-left edge of a freshly loaded page can differ from a
 * full-history computation, and that region is off-screen.
 */

/** Convenience: an all-NaN column of the right length. */
function blank(length: number): Float64Array {
  const out = new Float64Array(length);
  out.fill(NaN);
  return out;
}

/**
 * Simple moving average.
 *
 * Uses a running sum, so it is O(n) rather than O(n*period). The sum is rebuilt
 * from scratch if it ever goes non-finite, which keeps one bad input bar from
 * poisoning every subsequent value.
 */
export function sma(values: ArrayLike<number>, period: number): Float64Array {
  const n = values.length;
  const out = blank(n);
  if (period <= 0 || n < period) return out;

  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) {
      if (!Number.isFinite(sum)) {
        // Recover rather than propagate: recompute this window directly.
        let window = 0;
        for (let j = i - period + 1; j <= i; j += 1) window += values[j];
        sum = window;
      }
      out[i] = sum / period;
    }
  }
  return out;
}

/** Population standard deviation over a rolling window (Pine's `ta.stdev`). */
export function stdev(values: ArrayLike<number>, period: number): Float64Array {
  const n = values.length;
  const out = blank(n);
  if (period <= 0 || n < period) return out;

  const means = sma(values, period);
  for (let i = period - 1; i < n; i += 1) {
    const mean = means[i];
    let acc = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const diff = values[j] - mean;
      acc += diff * diff;
    }
    // Population (divide by n), matching TradingView. Sample deviation would
    // make every Bollinger band slightly wider than the one on their chart.
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

/**
 * Exponential moving average, SMA-seeded.
 *
 * The seed matters: seeding from the first value instead makes the first few
 * hundred bars visibly wrong on short periods.
 */
export function ema(values: ArrayLike<number>, period: number): Float64Array {
  const n = values.length;
  const out = blank(n);
  if (period <= 0 || n < period) return out;

  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < n; i += 1) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's smoothing (Pine's `ta.rma`): an EMA with alpha = 1/period.
 *
 * RSI, ATR and ADX are all defined on this. Substituting a standard EMA gives
 * numbers that look plausible and are wrong by several points.
 */
export function rma(values: ArrayLike<number>, period: number): Float64Array {
  const n = values.length;
  const out = blank(n);
  if (period <= 0 || n < period) return out;

  const alpha = 1 / period;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < n; i += 1) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Linearly weighted moving average: weight `period` on the newest bar, 1 on the oldest. */
export function wma(values: ArrayLike<number>, period: number): Float64Array {
  const n = values.length;
  const out = blank(n);
  if (period <= 0 || n < period) return out;

  const denominator = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i += 1) {
    let acc = 0;
    for (let k = 0; k < period; k += 1) {
      // k = 0 is the newest bar in the window and carries the largest weight.
      acc += values[i - k] * (period - k);
    }
    out[i] = acc / denominator;
  }
  return out;
}

/**
 * Hull moving average: `wma(2*wma(n/2) - wma(n), sqrt(n))`.
 *
 * Much faster to turn than an EMA of the same length, at the cost of overshoot.
 */
export function hma(values: ArrayLike<number>, period: number): Float64Array {
  const n = values.length;
  if (period <= 1 || n < period) return blank(n);

  const half = Math.max(1, Math.round(period / 2));
  const sqrt = Math.max(1, Math.round(Math.sqrt(period)));
  const fast = wma(values, half);
  const slow = wma(values, period);

  const raw = new Float64Array(n);
  raw.fill(NaN);
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(fast[i]) && Number.isFinite(slow[i])) {
      raw[i] = 2 * fast[i] - slow[i];
    }
  }

  // `wma` cannot skip a NaN prefix, so run it on the finite tail and put the
  // result back at the right offset.
  let first = 0;
  while (first < n && !Number.isFinite(raw[first])) first += 1;
  const out = blank(n);
  if (n - first < sqrt) return out;

  const smoothed = wma(raw.subarray(first), sqrt);
  for (let i = 0; i < smoothed.length; i += 1) out[first + i] = smoothed[i];
  return out;
}

/**
 * Relative Strength Index (Wilder).
 *
 * An all-up window gives 100 and an all-down window gives 0; both are real
 * readings, so the zero-loss case returns 100 rather than dividing by zero.
 */
export function rsi(close: ArrayLike<number>, period: number): Float64Array {
  const n = close.length;
  const out = blank(n);
  if (period <= 0 || n <= period) return out;

  const gains = new Float64Array(n);
  const losses = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    const change = close[i] - close[i - 1];
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? -change : 0;
  }

  // Bar 0 has no change, so the averages start at bar 1.
  const avgGain = rma(gains.subarray(1), period);
  const avgLoss = rma(losses.subarray(1), period);
  for (let i = 0; i < avgGain.length; i += 1) {
    const gain = avgGain[i];
    const loss = avgLoss[i];
    if (!Number.isFinite(gain) || !Number.isFinite(loss)) continue;
    out[i + 1] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface MacdResult {
  macd: Float64Array;
  signal: Float64Array;
  histogram: Float64Array;
}

/** MACD line, its signal EMA, and the histogram between them. */
export function macd(
  close: ArrayLike<number>,
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MacdResult {
  const n = close.length;
  const fast = ema(close, fastPeriod);
  const slow = ema(close, slowPeriod);

  const line = blank(n);
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(fast[i]) && Number.isFinite(slow[i])) line[i] = fast[i] - slow[i];
  }

  let first = 0;
  while (first < n && !Number.isFinite(line[first])) first += 1;

  const signal = blank(n);
  const histogram = blank(n);
  if (n - first >= signalPeriod) {
    const smoothed = ema(line.subarray(first), signalPeriod);
    for (let i = 0; i < smoothed.length; i += 1) {
      const at = first + i;
      signal[at] = smoothed[i];
      if (Number.isFinite(smoothed[i])) histogram[at] = line[at] - smoothed[i];
    }
  }
  return { macd: line, signal, histogram };
}

export interface BollingerResult {
  middle: Float64Array;
  upper: Float64Array;
  lower: Float64Array;
}

/** Bollinger Bands: an SMA basis with population-stdev envelopes. */
export function bollinger(
  close: ArrayLike<number>,
  period: number,
  multiplier: number,
): BollingerResult {
  const n = close.length;
  const middle = sma(close, period);
  const deviation = stdev(close, period);
  const upper = blank(n);
  const lower = blank(n);
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(middle[i]) || !Number.isFinite(deviation[i])) continue;
    upper[i] = middle[i] + multiplier * deviation[i];
    lower[i] = middle[i] - multiplier * deviation[i];
  }
  return { middle, upper, lower };
}

/**
 * True range.
 *
 * Bar 0 has no previous close, so it is NaN rather than the bar's own range —
 * seeding it with `high - low` biases the first ATR reading low.
 */
export function trueRange(
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
): Float64Array {
  const n = high.length;
  const out = blank(n);
  for (let i = 1; i < n; i += 1) {
    const previousClose = close[i - 1];
    out[i] = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - previousClose),
      Math.abs(low[i] - previousClose),
    );
  }
  return out;
}

/** Average True Range (Wilder). */
export function atr(
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
  period: number,
): Float64Array {
  const n = high.length;
  const out = blank(n);
  const tr = trueRange(high, low, close);
  if (n <= period) return out;

  const smoothed = rma(tr.subarray(1), period);
  for (let i = 0; i < smoothed.length; i += 1) out[i + 1] = smoothed[i];
  return out;
}

export interface StochasticResult {
  k: Float64Array;
  d: Float64Array;
}

/**
 * Stochastic oscillator.
 *
 * `kPeriod` is the lookback for raw %K, `kSmooth` smooths it (3 gives the
 * familiar "slow" stochastic) and `dSmooth` produces %D.
 */
export function stochastic(
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
  kPeriod: number,
  kSmooth: number,
  dSmooth: number,
): StochasticResult {
  const n = close.length;
  const raw = blank(n);
  for (let i = kPeriod - 1; i < n; i += 1) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j += 1) {
      if (high[j] > highest) highest = high[j];
      if (low[j] < lowest) lowest = low[j];
    }
    const span = highest - lowest;
    // A flat window has no range to position within; 50 is the neutral reading
    // TradingView also reports here.
    raw[i] = span === 0 ? 50 : ((close[i] - lowest) / span) * 100;
  }

  let first = 0;
  while (first < n && !Number.isFinite(raw[first])) first += 1;

  const k = blank(n);
  const d = blank(n);
  if (n - first < kSmooth) return { k, d };

  const smoothedK = sma(raw.subarray(first), kSmooth);
  for (let i = 0; i < smoothedK.length; i += 1) k[first + i] = smoothedK[i];

  let kFirst = 0;
  while (kFirst < n && !Number.isFinite(k[kFirst])) kFirst += 1;
  if (n - kFirst >= dSmooth) {
    const smoothedD = sma(k.subarray(kFirst), dSmooth);
    for (let i = 0; i < smoothedD.length; i += 1) d[kFirst + i] = smoothedD[i];
  }
  return { k, d };
}

export interface AdxResult {
  adx: Float64Array;
  plusDi: Float64Array;
  minusDi: Float64Array;
}

/**
 * Average Directional Index with its two directional indicators.
 *
 * ADX measures trend STRENGTH and is direction-blind; the sign of the move is
 * in +DI vs -DI. Reading ADX alone as bullish is the classic misuse.
 */
export function adx(
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
  period: number,
): AdxResult {
  const n = high.length;
  const empty = { adx: blank(n), plusDi: blank(n), minusDi: blank(n) };
  if (n <= period + 1) return empty;

  const tr = trueRange(high, low, close);
  const plusDm = new Float64Array(n);
  const minusDm = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    // Only the dominant direction records movement; an inside bar records none.
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }

  const smoothedTr = rma(tr.subarray(1), period);
  const smoothedPlus = rma(plusDm.subarray(1), period);
  const smoothedMinus = rma(minusDm.subarray(1), period);

  const plusDi = blank(n);
  const minusDi = blank(n);
  const dx = blank(n);
  for (let i = 0; i < smoothedTr.length; i += 1) {
    const at = i + 1;
    const range = smoothedTr[i];
    if (!Number.isFinite(range) || range === 0) continue;
    const plus = (100 * smoothedPlus[i]) / range;
    const minus = (100 * smoothedMinus[i]) / range;
    plusDi[at] = plus;
    minusDi[at] = minus;
    const total = plus + minus;
    dx[at] = total === 0 ? 0 : (100 * Math.abs(plus - minus)) / total;
  }

  let first = 0;
  while (first < n && !Number.isFinite(dx[first])) first += 1;

  const out = blank(n);
  if (n - first >= period) {
    const smoothedDx = rma(dx.subarray(first), period);
    for (let i = 0; i < smoothedDx.length; i += 1) out[first + i] = smoothedDx[i];
  }
  return { adx: out, plusDi, minusDi };
}

export interface SupertrendResult {
  /** The active band — lower band while long, upper band while short. */
  line: Float64Array;
  /** +1 trending up (line is support), -1 trending down (line is resistance). */
  direction: Float64Array;
}

/**
 * SuperTrend.
 *
 * Faithful to the widely used Pine version: the bands ratchet (they may only
 * move in the favourable direction while the trend holds) and the flip is
 * tested against the PREVIOUS bar's band, not the current one.
 */
export function supertrend(
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
  period: number,
  multiplier: number,
): SupertrendResult {
  const n = close.length;
  const line = blank(n);
  const direction = blank(n);
  const range = atr(high, low, close, period);

  let start = 0;
  while (start < n && !Number.isFinite(range[start])) start += 1;
  if (start >= n) return { line, direction };

  let upper = NaN;
  let lower = NaN;
  let trend = 1;

  for (let i = start; i < n; i += 1) {
    const mid = (high[i] + low[i]) / 2;
    let up = mid - multiplier * range[i];
    let down = mid + multiplier * range[i];

    if (i > start) {
      // Ratchet: the support band may only rise while price holds above it.
      if (close[i - 1] > lower) up = Math.max(up, lower);
      if (close[i - 1] < upper) down = Math.min(down, upper);
      if (trend === -1 && close[i] > upper) trend = 1;
      else if (trend === 1 && close[i] < lower) trend = -1;
    } else {
      trend = close[i] >= mid ? 1 : -1;
    }

    lower = up;
    upper = down;
    direction[i] = trend;
    line[i] = trend === 1 ? lower : upper;
  }
  return { line, direction };
}

/**
 * Session-anchored VWAP, reset at each UTC day boundary.
 *
 * The data is broker server time and we never shift it, so "day" here is the
 * broker's day — which is the boundary a trader watching this feed actually
 * sees. Bars with no volume contribute nothing rather than dragging the
 * average toward the untraded price.
 */
export function vwap(
  time: ArrayLike<number>,
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
  volume: ArrayLike<number>,
): Float64Array {
  const n = close.length;
  const out = blank(n);
  const SECONDS_PER_DAY = 86400;

  let day = NaN;
  let cumulativePv = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < n; i += 1) {
    const current = Math.floor(time[i] / SECONDS_PER_DAY);
    if (current !== day) {
      day = current;
      cumulativePv = 0;
      cumulativeVolume = 0;
    }
    const typical = (high[i] + low[i] + close[i]) / 3;
    const size = volume[i];
    if (Number.isFinite(size) && size > 0) {
      cumulativePv += typical * size;
      cumulativeVolume += size;
    }
    if (cumulativeVolume > 0) out[i] = cumulativePv / cumulativeVolume;
  }
  return out;
}
