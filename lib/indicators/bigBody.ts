/**
 * "Big Body Candle Border + Retest" — a FAITHFUL port of the user's Pine
 * Script v6 indicator.
 *
 * Several Pine behaviours below look like bugs. They are reproduced exactly
 * and each one is marked `PINE QUIRK`. Do not "fix" them: the user's charts
 * are read against the Pine original, so a divergence is a regression even
 * when it is an improvement.
 *
 * Single pass over the columnar series, O(bars + levels). The typed arrays on
 * `CandleSeries` are read directly — M1 is 1.76M bars, so materialising an
 * array of `Bar` objects would cost hundreds of MB for nothing.
 */

import { TIMEFRAME_MINUTES, type CandleSeries } from '../candles/types';
import {
  PINE_MAX_OBJECTS,
  XAUUSD_MINTICK,
  isLevelMode,
  isThresholdMode,
  type BigBodyParams,
  type BigBodyResult,
  type BoxShape,
  type LabelShape,
  type LevelEvent,
  type SegmentShape,
} from './types';

/** One live Pine `Level` struct plus handles on the outputs it feeds. */
interface ActiveLevel {
  price: number;
  /** Pine `bar_index` at creation. */
  bar: number;
  /** Pine `dayId` at creation. */
  day: number;
  /** The `line` object; mutated in place as Pine mutates it via set_x2/set_color. */
  shape: SegmentShape;
  /** The data view of the same level; mutated in step with `shape`. */
  event: LevelEvent;
}

/**
 * Both public outputs of ONE pass. `computeBigBody` and `computeLevelEvents`
 * are thin wrappers over `run`, deliberately: two copies of this loop would
 * drift, and the backtest would then be testing a different strategy from the
 * one drawn on the chart.
 */
interface RunOutput {
  result: BigBodyResult;
  /** Every level ever created, in creation order. NEVER capped — see below. */
  events: LevelEvent[];
}

function validate(params: BigBodyParams): void {
  const {
    thresholdMode,
    thresholdPips,
    thresholdPercent,
    atrPeriod,
    atrMultiple,
    manualPip,
    maxDays,
    minGap,
    levelMode,
  } = params;

  if (!isThresholdMode(thresholdMode)) {
    throw new Error(`Unknown thresholdMode ${JSON.stringify(thresholdMode)}`);
  }

  // Only the ACTIVE mode's inputs are checked. The other modes' fields are
  // always present (they have defaults), so validating them unconditionally
  // would let a field nothing reads veto a perfectly valid run.
  if (thresholdMode === 'pips' && (!Number.isFinite(thresholdPips) || thresholdPips < 0)) {
    throw new Error(`thresholdPips must be a finite number >= 0, received ${String(thresholdPips)}`);
  }
  if (thresholdMode === 'percent' && (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0)) {
    throw new Error(
      `thresholdPercent must be a finite number > 0, received ${String(thresholdPercent)}`,
    );
  }
  if (thresholdMode === 'atr') {
    if (!Number.isInteger(atrPeriod) || atrPeriod < 1) {
      throw new Error(`atrPeriod must be an integer >= 1, received ${String(atrPeriod)}`);
    }
    if (!Number.isFinite(atrMultiple) || atrMultiple <= 0) {
      throw new Error(`atrMultiple must be a finite number > 0, received ${String(atrMultiple)}`);
    }
  }
  if (!Number.isFinite(manualPip) || manualPip <= 0) {
    throw new Error(`manualPip must be a finite number > 0, received ${String(manualPip)}`);
  }
  if (!Number.isFinite(maxDays) || maxDays < 0) {
    throw new Error(`maxDays must be a finite number >= 0, received ${String(maxDays)}`);
  }
  if (!Number.isFinite(minGap) || minGap < 1) {
    throw new Error(`minGap must be a finite number >= 1, received ${String(minGap)}`);
  }
  if (!isLevelMode(levelMode)) {
    throw new Error(`Unknown levelMode ${JSON.stringify(levelMode)}`);
  }
}

/**
 * Pine `timeframe.change("D")`: true when this bar opens a new calendar day.
 *
 * UTC getters on purpose. The CSVs carry broker server time with no zone, and
 * the whole app treats those stamps as UTC without shifting them; using local
 * getters here would make day boundaries depend on the machine's TZ.
 */
function isNewDay(prevTime: number, time: number): boolean {
  const a = new Date(prevTime * 1000);
  const b = new Date(time * 1000);
  return (
    a.getUTCFullYear() !== b.getUTCFullYear() ||
    a.getUTCMonth() !== b.getUTCMonth() ||
    a.getUTCDate() !== b.getUTCDate()
  );
}

/**
 * Pine's `max_boxes_count` / `max_lines_count` / `max_labels_count` of 500:
 * Pine silently deletes the OLDEST objects past the cap, per shape type, so
 * only the most recent 500 of each are ever on the chart. H1 at default params
 * produces 871 boxes; Pine shows 500 of them.
 */
function cap<T>(items: T[]): T[] {
  return items.length > PINE_MAX_OBJECTS ? items.slice(items.length - PINE_MAX_OBJECTS) : items;
}

/**
 * Wilder's ATR over the whole series, one value per bar.
 *
 * True range = max(high - low, |high - prevClose|, |low - prevClose|); the
 * first bar has no previous close, so it falls back to high - low. The first
 * `period` true ranges are averaged into the seed, and every bar after that is
 * Wilder-smoothed: `atr[i] = (atr[i-1] * (period - 1) + tr[i]) / period`.
 *
 * STRICTLY CAUSAL, which is the whole point: this feeds a backtest, and an ATR
 * that could see bar i+1 would make the strategy look prescient. Two rules
 * enforce it:
 *
 *  1. The loop only ever reads `high[i]`, `low[i]` and `close[i - 1]`, and
 *     carries state forward in a single accumulator. Nothing is back-filled.
 *  2. Bars with index < `period` get NaN — the seed is still being gathered,
 *     so publishing anything there would either be a value derived from bars
 *     that have not happened yet, or a partial average dressed up as an ATR.
 *     A NaN can never satisfy `body >= multiple * atr`, so those bars simply
 *     can never be big candles.
 *
 * Consequence of (2): running over a prefix of the series returns exactly the
 * same numbers at every shared index as running over the whole thing.
 *
 * Exported for the tests, which assert hand-computed values and that causality.
 */
export function wilderAtr(series: CandleSeries, period: number): Float64Array {
  const { high, low, close, count } = series;
  const atr = new Float64Array(count).fill(NaN);

  let seedSum = 0;
  /** The running Wilder average; NaN until the seed window has closed. */
  let prev = NaN;

  for (let i = 0; i < count; i++) {
    const h = high[i];
    const l = low[i];
    const tr =
      i === 0
        ? h - l
        : Math.max(h - l, Math.abs(h - close[i - 1]), Math.abs(l - close[i - 1]));

    if (i < period) {
      // Seeding. `prev` becomes the simple average on the last seed bar, but is
      // NOT published at that index — see rule (2) above.
      seedSum += tr;
      if (i === period - 1) prev = seedSum / period;
    } else {
      prev = (prev * (period - 1) + tr) / period;
      atr[i] = prev;
    }
  }

  return atr;
}

function run(series: CandleSeries, params: BigBodyParams): RunOutput {
  validate(params);

  const { time, open, high, low, close, count } = series;
  const {
    thresholdMode,
    thresholdPips,
    thresholdPercent,
    atrPeriod,
    atrMultiple,
    autoPip,
    manualPip,
    frameFull,
    showLabel,
    levelMode,
    maxDays,
    minGap,
  } = params;

  const pipSize = autoPip ? XAUUSD_MINTICK * 10.0 : manualPip;

  /**
   * ATR is a whole-series quantity, so it is computed ONCE here rather than per
   * bar, and only when the active mode actually needs it — `pips` and `percent`
   * must not pay for an extra pass over 1.76M bars they never read.
   */
  const atr = thresholdMode === 'atr' ? wilderAtr(series, atrPeriod) : null;

  /**
   * Fallback width for the FINAL bar only. Pine's `time_close` is derived here
   * as the NEXT bar's `time`, never `time + duration`: the series has weekend
   * (~49h) and daily (~63min) gaps, so a fixed duration would project a box or
   * line into dead space. The last bar has no successor, so the nominal
   * timeframe duration is the only thing left to use.
   */
  const fallbackDuration = TIMEFRAME_MINUTES[series.timeframe] * 60;

  const boxes: BoxShape[] = [];
  const labels: LabelShape[] = [];
  /** Every segment ever created, in creation order; mutated in place. */
  const segments: SegmentShape[] = [];
  /** The same levels as data, same order, same length; mutated in place. */
  const events: LevelEvent[] = [];
  const active: ActiveLevel[] = [];

  let dayId = 0;
  let bigCandles = 0;
  let touchedCount = 0;
  let expiredCount = 0;

  for (let i = 0; i < count; i++) {
    const t = time[i];
    // time_close: the next bar's open. See `fallbackDuration` above.
    const timeClose = i + 1 < count ? time[i + 1] : t + fallbackDuration;

    // (a) dayId. Pine's `timeframe.change("D")` is true on the very first bar,
    // so dayId is 1 at index 0 — not 0.
    if (i === 0 || isNewDay(time[i - 1], t)) dayId += 1;

    const o = open[i];
    const h = high[i];
    const l = low[i];
    const c = close[i];

    // (b) Resolve EXISTING levels, before any level from this bar is created.
    // PINE QUIRK (order): Pine's resolution block runs above the `if newBig`
    // block, so a level created on bar N is first eligible on bar N+1 and can
    // never be resolved by the very bar that produced it — even though that
    // bar's own range always contains its own level price.
    //
    // Iterating DOWNWARDS, exactly as Pine's `for i = levelCount - 1 to 0`
    // does, so that removing in place cannot skip the next element.
    for (let k = active.length - 1; k >= 0; k--) {
      const level = active[k];
      // Strictly greater than: a delta equal to maxDays still lives.
      const expired = dayId - level.day > maxDays;
      const touched = i - level.bar >= minGap && l <= level.price && h >= level.price;

      if (expired || touched) {
        // PINE QUIRK (set_x2 asymmetry): an unresolved line is extended to the
        // bar's `time_close` each bar, but on resolution Pine calls
        // `line.set_x2(level.ln, time)` — the bar's OPEN. A resolved segment
        // therefore stops one bar width short of a pending one.
        level.shape.endTime = t;
        if (touched) {
          // PINE QUIRK (tie-break): a level that is expired AND touched on the
          // same bar is removed either way, but Pine only recolours on
          // `touched`, so `touched` wins.
          level.shape.state = 'touched';
          level.event.outcome = 'touched';
          level.event.touchedIndex = i;
          level.event.touchedTime = t;
          touchedCount += 1;
        } else {
          level.shape.state = 'expired';
          level.event.outcome = 'expired';
          expiredCount += 1;
        }
        active.splice(k, 1);
      } else {
        level.shape.endTime = timeClose;
      }
    }

    // (c) Big-candle detection and new levels.
    //
    // THE ONLY place "big" is decided, for both public entry points: they share
    // this one pass precisely so the chart and the backtest can never disagree
    // about which candles qualify.
    //
    // No epsilon on any comparison: Pine does not use one either, so a body a
    // hair under the threshold must stay under it, and all three modes are
    // inclusive at the boundary (`>=`).
    const body = Math.abs(c - o);
    // Label text is in pips in every mode, so this is always needed.
    const bodyPips = body / pipSize;

    let newBig: boolean;
    if (thresholdMode === 'percent') {
      // Scale-free: measured against THIS bar's close, so the same percentage
      // means the same thing at 1800 and at 4400.
      newBig = body >= (thresholdPercent / 100) * c;
    } else if (atr !== null) {
      // Volatility-relative. NaN before the ATR seed has closed, and NaN fails
      // the comparison, so those early bars are never big — by construction.
      newBig = body >= atrMultiple * atr[i];
    } else {
      // Pine: `bodyPips >= thresholdPips and barstate.isconfirmed`. Over
      // historical bars `barstate.isconfirmed` is always true, so it drops out.
      newBig = bodyPips >= thresholdPips;
    }

    if (newBig) {
      bigCandles += 1;
      const topY = frameFull ? h : Math.max(o, c);
      const bottomY = frameFull ? l : Math.min(o, c);
      boxes.push({ time: t, endTime: timeClose, top: topY, bottom: bottomY });

      if (showLabel) {
        // Pine `math.round`. JS `Math.round` differs from Pine's for negative
        // halves (Math.round(-0.5) === -0), but bodyPips is |…| / positive pip
        // and therefore always >= 0, so plain Math.round is exact here.
        labels.push({ time: t, price: topY, text: `${Math.round(bodyPips)} pips` });
      }

      /**
       * `side` is OUR convention, not Pine's: Pine only implies a direction for
       * 'Impulse origin (auto)' (a bullish impulse parks its level at the low,
       * to be bought on the dip; a bearish one at the high). Pine assigns no
       * side at all under 'High' / 'Low' / 'High & Low' / 'Close' / 'Open', so
       * we derive it from the impulse candle's own direction in every mode.
       * Nothing about the state machine depends on it; it is carried for the
       * backtest.
       */
      const side: LevelEvent['side'] = c > o ? 'long' : 'short';
      const impulseBody = body;

      const addLevel = (price: number): void => {
        // Pine `addLevel`: line.new(time, price, time_close, price), pending.
        const shape: SegmentShape = { time: t, endTime: timeClose, price, state: 'pending' };
        segments.push(shape);
        // The data twin. Touch fields stay absent until (and unless) a touch
        // resolves it, so they are present if and only if outcome is 'touched'.
        const event: LevelEvent = {
          price,
          side,
          createdIndex: i,
          createdTime: t,
          impulseBody,
          outcome: 'pending',
        };
        events.push(event);
        active.push({ price, bar: i, day: dayId, shape, event });
      };

      // Pine uses a chain of independent `if`s, so 'High & Low' pushes TWO
      // levels — high first, then low. Both inherit the one impulse's `side`:
      // they come from the same candle, so they cannot disagree about it.
      if (levelMode === 'Impulse origin (auto)') addLevel(c > o ? l : h);
      if (levelMode === 'High & Low' || levelMode === 'High') addLevel(h);
      if (levelMode === 'High & Low' || levelMode === 'Low') addLevel(l);
      if (levelMode === 'Close') addLevel(c);
      if (levelMode === 'Open') addLevel(o);
    }
  }

  // Levels still unresolved when the series ends stay `pending`, already
  // extended to the last bar's time_close by the loop above.
  const stats = {
    totalBars: count,
    bigCandles,
    levelsCreated: segments.length,
    touched: touchedCount,
    expired: expiredCount,
    pending: active.length,
    // Stats are computed from the FULL uncapped run; only the arrays are
    // capped, so `bigCandles` stays the true count.
    truncated:
      boxes.length > PINE_MAX_OBJECTS ||
      labels.length > PINE_MAX_OBJECTS ||
      segments.length > PINE_MAX_OBJECTS,
  };

  return {
    result: {
      timeframe: series.timeframe,
      params,
      boxes: cap(boxes),
      labels: cap(labels),
      segments: cap(segments),
      stats,
    },
    events,
  };
}

/** Drawing geometry for the chart: Pine's shapes, under Pine's 500-object cap. */
export function computeBigBody(series: CandleSeries, params: BigBodyParams): BigBodyResult {
  return run(series, params).result;
}

/**
 * The SAME state machine's decisions as data, for the strategy tester.
 *
 * Deliberately NOT capped. `cap` reproduces Pine's drawing limit, which is a
 * property of the chart, not of the strategy: H1 at default params creates 871
 * levels and Pine draws the last 500 of them. A backtest fed 500 would silently
 * ignore 371 levels and report on a strategy nobody asked about.
 *
 * Events come back in creation order (ascending `createdIndex`), and within one
 * impulse in Pine's own push order — for 'High & Low', high then low.
 */
export function computeLevelEvents(series: CandleSeries, params: BigBodyParams): LevelEvent[] {
  return run(series, params).events;
}
