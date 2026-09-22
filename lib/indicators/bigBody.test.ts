/**
 * Hand-authored fixtures for the Big Body port. Every expectation below was
 * worked out by hand from the Pine source, including the behaviours that look
 * like bugs (see the `quirk:` comments). Nothing here is "what the code
 * happens to produce".
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { computeBigBody, computeLevelEvents, wilderAtr } from './bigBody';
import {
  DEFAULT_BIG_BODY_PARAMS,
  PINE_MAX_OBJECTS,
  type BigBodyParams,
  type LevelEvent,
} from './types';
import { parseCsvFile } from '../candles/parser';
import type { CandleSeries, Timeframe } from '../candles/types';

const HOUR = 3600;

/** 2021-09-21 13:00 UTC, matching the first bar of the real H1 CSV. */
const T0 = Date.UTC(2021, 8, 21, 13, 0, 0) / 1000;

interface RawBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function makeSeries(bars: RawBar[], timeframe: Timeframe = 'H1'): CandleSeries {
  const n = bars.length;
  const s = {
    timeframe,
    time: new Int32Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Int32Array(n),
    count: n,
    spread: new Int32Array(n),
    skippedRows: 0,
  };
  for (let i = 0; i < n; i++) {
    s.time[i] = bars[i].time;
    s.open[i] = bars[i].open;
    s.high[i] = bars[i].high;
    s.low[i] = bars[i].low;
    s.close[i] = bars[i].close;
  }
  return s;
}

/** Params tuned for hand fixtures: pip = 0.01, so 100 pips = a body of 1.00. */
function params(over: Partial<BigBodyParams> = {}): BigBodyParams {
  return {
    ...DEFAULT_BIG_BODY_PARAMS,
    thresholdPips: 100,
    maxDays: 10,
    ...over,
  };
}

/** A quiet bar that is never big and never touches anything near 99..105. */
function calm(time: number): RawBar {
  return { time, open: 200, high: 200.2, low: 199.8, close: 200.1 };
}

describe('computeBigBody — boxes and labels', () => {
  const bigUp: RawBar = { time: T0, open: 100, high: 105, low: 99, close: 102 };

  it('emits exactly one box per big candle, framing the whole candle', () => {
    const series = makeSeries([bigUp, calm(T0 + HOUR), calm(T0 + 2 * HOUR)]);
    const r = computeBigBody(series, params({ frameFull: true }));

    expect(r.boxes).toHaveLength(1);
    // body = |102 - 100| / 0.01 = 200 pips >= 100 -> big.
    expect(r.boxes[0]).toEqual({
      time: T0,
      endTime: T0 + HOUR, // time_close = the NEXT bar's time
      top: 105,
      bottom: 99,
    });
    expect(r.stats.bigCandles).toBe(1);
    expect(r.stats.totalBars).toBe(3);
  });

  it('frameFull=false frames the body only', () => {
    const series = makeSeries([bigUp, calm(T0 + HOUR)]);
    const r = computeBigBody(series, params({ frameFull: false }));
    expect(r.boxes[0].top).toBe(102);
    expect(r.boxes[0].bottom).toBe(100);
  });

  it('labels with rounded pips, anchored at the box top', () => {
    const series = makeSeries([bigUp, calm(T0 + HOUR)]);
    const r = computeBigBody(series, params({ frameFull: true }));
    expect(r.labels).toEqual([{ time: T0, price: 105, text: '200 pips' }]);

    const body = computeBigBody(series, params({ frameFull: false }));
    expect(body.labels[0].price).toBe(102);
  });

  it('rounds the pip count the way Pine does for a non-integer body', () => {
    // |100 - 101.235| / 0.01 = 123.49999... -> 123
    const bar: RawBar = { time: T0, open: 100, high: 102, low: 99, close: 101.235 };
    const r = computeBigBody(makeSeries([bar, calm(T0 + HOUR)]), params());
    expect(r.labels[0].text).toBe('123 pips');
  });

  it('showLabel=false suppresses labels but not boxes', () => {
    const series = makeSeries([bigUp, calm(T0 + HOUR)]);
    const r = computeBigBody(series, params({ showLabel: false }));
    expect(r.boxes).toHaveLength(1);
    expect(r.labels).toHaveLength(0);
  });

  it('uses mintick * 10 for pipSize when autoPip is set', () => {
    // XAUUSD_MINTICK 0.001 * 10 = 0.01, identical to the manual default, so a
    // manualPip that would NOT trigger must be ignored under autoPip.
    const series = makeSeries([bigUp, calm(T0 + HOUR)]);
    const r = computeBigBody(series, params({ autoPip: true, manualPip: 1 }));
    expect(r.stats.bigCandles).toBe(1);
    expect(r.labels[0].text).toBe('200 pips');
  });

  it('threshold is inclusive (>=), with no epsilon', () => {
    // body exactly 100 pips
    const exact: RawBar = { time: T0, open: 100, high: 102, low: 99, close: 101 };
    expect(computeBigBody(makeSeries([exact, calm(T0 + HOUR)]), params()).stats.bigCandles).toBe(1);
    const under: RawBar = { time: T0, open: 100, high: 102, low: 99, close: 100.99 };
    expect(computeBigBody(makeSeries([under, calm(T0 + HOUR)]), params()).stats.bigCandles).toBe(0);
  });
});

describe('computeBigBody — level modes', () => {
  const up: RawBar = { time: T0, open: 100, high: 105, low: 99, close: 102 };
  const down: RawBar = { time: T0, open: 102, high: 105, low: 99, close: 100 };

  function prices(bar: RawBar, levelMode: BigBodyParams['levelMode']): number[] {
    const r = computeBigBody(makeSeries([bar, calm(T0 + HOUR)]), params({ levelMode }));
    return r.segments.map((s) => s.price);
  }

  it("'Impulse origin (auto)' takes low on an up candle, high on a down candle", () => {
    expect(prices(up, 'Impulse origin (auto)')).toEqual([99]);
    expect(prices(down, 'Impulse origin (auto)')).toEqual([105]);
  });

  it("'High & Low' pushes TWO levels, high first", () => {
    expect(prices(up, 'High & Low')).toEqual([105, 99]);
  });

  it("'High', 'Low', 'Close', 'Open' each push one", () => {
    expect(prices(up, 'High')).toEqual([105]);
    expect(prices(up, 'Low')).toEqual([99]);
    expect(prices(up, 'Close')).toEqual([102]);
    expect(prices(up, 'Open')).toEqual([100]);
    expect(prices(down, 'Close')).toEqual([100]);
    expect(prices(down, 'Open')).toEqual([102]);
  });

  it('a level created on bar N is never resolved by bar N itself', () => {
    // The big candle's own range (99..105) contains its own level price (99),
    // but Pine runs the resolution loop BEFORE creating the level.
    const r = computeBigBody(makeSeries([up, calm(T0 + HOUR)]), params({ minGap: 0 + 1 }));
    expect(r.segments[0].state).toBe('pending');
  });
});

describe('computeBigBody — level resolution', () => {
  const up: RawBar = { time: T0, open: 100, high: 105, low: 99, close: 102 };

  it('a touch at or after minGap resolves the level to `touched`, ending at the touching bar OPEN', () => {
    const bars = [
      up, // bar 0: creates level at 99
      { time: T0 + HOUR, open: 103, high: 104, low: 101, close: 103 }, // no touch
      // body 50 pips, so this bar touches but is not itself big.
      { time: T0 + 2 * HOUR, open: 101, high: 104, low: 98, close: 100.5 }, // 98 <= 99 <= 104
      calm(T0 + 3 * HOUR),
    ];
    const r = computeBigBody(makeSeries(bars), params({ minGap: 1 }));
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].state).toBe('touched');
    expect(r.segments[0].time).toBe(T0);
    // quirk: Pine calls set_x2(time) on resolution — the touching bar's OPEN,
    // not its time_close, so the segment stops one bar short of a pending one.
    expect(r.segments[0].endTime).toBe(T0 + 2 * HOUR);
    expect(r.stats.touched).toBe(1);
    expect(r.stats.pending).toBe(0);
  });

  it('touch bounds are inclusive on both sides', () => {
    const bars = [
      up,
      { time: T0 + HOUR, open: 99, high: 99, low: 99, close: 99 }, // low == high == price
      calm(T0 + 2 * HOUR),
    ];
    const r = computeBigBody(makeSeries(bars), params({ minGap: 1 }));
    expect(r.segments[0].state).toBe('touched');
    expect(r.segments[0].endTime).toBe(T0 + HOUR);
  });

  it('a touch EARLIER than minGap does not resolve the level', () => {
    const bars = [
      up, // level at 99, bar 0
      { time: T0 + HOUR, open: 100, high: 104, low: 98, close: 100 }, // would touch, but gap 1 < 2
      calm(T0 + 2 * HOUR), // never touches 99
      calm(T0 + 3 * HOUR),
    ];
    const r = computeBigBody(makeSeries(bars), params({ minGap: 2 }));
    expect(r.segments[0].state).toBe('pending');
    expect(r.stats.touched).toBe(0);
    expect(r.stats.pending).toBe(1);
  });

  it('expires a level when the day delta EXCEEDS maxDays', () => {
    const nextDay = Date.UTC(2021, 8, 22, 9, 0, 0) / 1000;
    const bars = [
      up, // day 1
      calm(T0 + HOUR), // still day 1 -> delta 0, not > 0
      calm(nextDay), // day 2 -> delta 1 > 0 -> expired
      calm(nextDay + HOUR),
    ];
    const r = computeBigBody(makeSeries(bars), params({ maxDays: 0 }));
    expect(r.segments[0].state).toBe('expired');
    expect(r.segments[0].endTime).toBe(nextDay); // set_x2(time) again
    expect(r.stats.expired).toBe(1);
  });

  it('does not expire while the day delta is still within maxDays', () => {
    const nextDay = Date.UTC(2021, 8, 22, 9, 0, 0) / 1000;
    const bars = [up, calm(T0 + HOUR), calm(nextDay), calm(nextDay + HOUR)];
    const r = computeBigBody(makeSeries(bars), params({ maxDays: 1 }));
    expect(r.segments[0].state).toBe('pending');
  });

  it('expired AND touched on the same bar reports `touched`', () => {
    const nextDay = Date.UTC(2021, 8, 22, 9, 0, 0) / 1000;
    const bars = [
      up, // level at 99, day 1
      calm(T0 + HOUR),
      { time: nextDay, open: 100, high: 104, low: 98, close: 100 }, // day 2: expired AND touches 99
      calm(nextDay + HOUR),
    ];
    const r = computeBigBody(makeSeries(bars), params({ maxDays: 0, minGap: 1 }));
    // quirk: Pine removes the level for either reason but only recolours on
    // `touched`, so the touched state wins the tie.
    expect(r.segments[0].state).toBe('touched');
    expect(r.stats.touched).toBe(1);
    expect(r.stats.expired).toBe(0);
  });

  it('leaves an unresolved level pending, extended to the last bar time_close', () => {
    const bars = [up, calm(T0 + HOUR), calm(T0 + 2 * HOUR)];
    const r = computeBigBody(makeSeries(bars), params());
    expect(r.segments[0].state).toBe('pending');
    // Last bar has no successor: fall back to time + timeframe duration.
    expect(r.segments[0].endTime).toBe(T0 + 2 * HOUR + HOUR);
    expect(r.stats.pending).toBe(1);
  });

  it('removes levels backwards without skipping when several resolve on one bar', () => {
    const b0: RawBar = { time: T0, open: 100, high: 105, low: 99, close: 102 };
    const b1: RawBar = { time: T0 + HOUR, open: 100, high: 105, low: 99, close: 102 };
    const bars = [
      b0, // level 99
      b1, // level 99 (second)
      { time: T0 + 2 * HOUR, open: 100, high: 104, low: 98, close: 100 }, // touches both
      calm(T0 + 3 * HOUR),
    ];
    const r = computeBigBody(makeSeries(bars), params({ minGap: 1 }));
    expect(r.segments).toHaveLength(2);
    expect(r.segments.map((s) => s.state)).toEqual(['touched', 'touched']);
    expect(r.stats.touched).toBe(2);
  });
});

describe('computeBigBody — time_close derivation', () => {
  it('uses the next bar time across a weekend gap, not time + duration', () => {
    const friday = Date.UTC(2021, 8, 24, 20, 0, 0) / 1000; // Fri 20:00
    const sunday = Date.UTC(2021, 8, 26, 21, 0, 0) / 1000; // Sun 21:00, ~49h later
    const bars = [
      { time: friday, open: 100, high: 105, low: 99, close: 102 },
      calm(sunday),
      calm(sunday + HOUR),
    ];
    const r = computeBigBody(makeSeries(bars), params());
    expect(r.boxes[0].endTime).toBe(sunday);
    expect(r.boxes[0].endTime).not.toBe(friday + HOUR);
    expect(sunday - friday).toBeGreaterThan(40 * HOUR);
  });
});

describe('computeBigBody — Pine 500-object cap', () => {
  it('keeps the most recent 500 of each shape and flags truncated', () => {
    const n = 600;
    const bars: RawBar[] = [];
    for (let i = 0; i < n; i++) {
      // Every bar is a big candle; prices drift so nothing ever touches.
      const base = 100 + i * 10;
      bars.push({ time: T0 + i * HOUR, open: base, high: base + 5, low: base - 1, close: base + 2 });
    }
    const r = computeBigBody(makeSeries(bars), params({ maxDays: 1000, minGap: 1 }));

    // Stats come from the FULL run, before capping.
    expect(r.stats.bigCandles).toBe(n);
    expect(r.stats.levelsCreated).toBe(n);
    expect(r.stats.truncated).toBe(true);

    expect(r.boxes).toHaveLength(PINE_MAX_OBJECTS);
    expect(r.labels).toHaveLength(PINE_MAX_OBJECTS);
    expect(r.segments).toHaveLength(PINE_MAX_OBJECTS);

    // Most recent kept, oldest dropped.
    expect(r.boxes[r.boxes.length - 1].time).toBe(T0 + (n - 1) * HOUR);
    expect(r.boxes[0].time).toBe(T0 + (n - PINE_MAX_OBJECTS) * HOUR);
    expect(r.segments[0].time).toBe(T0 + (n - PINE_MAX_OBJECTS) * HOUR);
  });

  it('does not flag truncated below the cap', () => {
    const r = computeBigBody(
      makeSeries([{ time: T0, open: 100, high: 105, low: 99, close: 102 }, calm(T0 + HOUR)]),
      params(),
    );
    expect(r.stats.truncated).toBe(false);
  });
});

describe('computeBigBody — misc', () => {
  it('handles an empty series', () => {
    const r = computeBigBody(makeSeries([]), params());
    expect(r.boxes).toEqual([]);
    expect(r.segments).toEqual([]);
    expect(r.stats.totalBars).toBe(0);
  });

  it('echoes the timeframe and params', () => {
    const p = params();
    const r = computeBigBody(makeSeries([calm(T0)], 'D1'), p);
    expect(r.timeframe).toBe('D1');
    expect(r.params).toEqual(p);
  });

  it('counts dayId from 1 on the first bar (Pine timeframe.change("D") fires at index 0)', () => {
    // maxDays 0 and the level created on the first bar of day 1: a second bar
    // on the same day must NOT expire it, proving day numbering is per-bar.
    const bars = [
      { time: T0, open: 100, high: 105, low: 99, close: 102 },
      calm(T0 + HOUR),
    ];
    expect(computeBigBody(makeSeries(bars), params({ maxDays: 0 })).segments[0].state).toBe(
      'pending',
    );
  });
});

describe('computeBigBody — param validation', () => {
  const series = makeSeries([calm(T0)]);
  const cases: Array<[string, Partial<BigBodyParams>]> = [
    ['thresholdPips < 0', { thresholdPips: -1 }],
    ['manualPip <= 0', { manualPip: 0 }],
    ['manualPip negative', { manualPip: -0.01 }],
    ['maxDays < 0', { maxDays: -1 }],
    ['minGap < 1', { minGap: 0 }],
  ];
  for (const [name, over] of cases) {
    it(`throws on ${name}`, () => {
      expect(() => computeBigBody(series, params(over))).toThrow(Error);
    });
  }

  it('throws on an unknown levelMode', () => {
    expect(() =>
      computeBigBody(series, { ...params(), levelMode: 'Nonsense' as BigBodyParams['levelMode'] }),
    ).toThrow(/levelMode/);
  });

  it('throws on non-finite numbers', () => {
    expect(() => computeBigBody(series, params({ thresholdPips: NaN }))).toThrow(Error);
  });
});

/* ---------- computeLevelEvents: the same state machine, as data ---------- */

describe('computeLevelEvents — side derivation', () => {
  const up: RawBar = { time: T0, open: 100, high: 105, low: 99, close: 102 };
  const down: RawBar = { time: T0, open: 102, high: 105, low: 99, close: 100 };

  it("a bullish impulse leaves its level at the LOW and is a 'long'", () => {
    const e = computeLevelEvents(makeSeries([up, calm(T0 + HOUR)]), params());
    expect(e).toHaveLength(1);
    expect(e[0].side).toBe('long');
    expect(e[0].price).toBe(99);
    expect(e[0].createdIndex).toBe(0);
    expect(e[0].createdTime).toBe(T0);
  });

  it("a bearish impulse leaves its level at the HIGH and is a 'short'", () => {
    const e = computeLevelEvents(makeSeries([down, calm(T0 + HOUR)]), params());
    expect(e[0].side).toBe('short');
    expect(e[0].price).toBe(105);
  });

  it('derives side from the impulse for the directionless level modes too', () => {
    // Our convention, not Pine's: Pine assigns no side outside
    // 'Impulse origin (auto)'. The impulse candle's own direction is used.
    for (const levelMode of ['High', 'Low', 'Close', 'Open'] as const) {
      expect(
        computeLevelEvents(makeSeries([up, calm(T0 + HOUR)]), params({ levelMode }))[0].side,
      ).toBe('long');
      expect(
        computeLevelEvents(makeSeries([down, calm(T0 + HOUR)]), params({ levelMode }))[0].side,
      ).toBe('short');
    }
  });

  it("'High & Low' emits two events, high first, both inheriting the impulse side", () => {
    const e = computeLevelEvents(
      makeSeries([up, calm(T0 + HOUR)]),
      params({ levelMode: 'High & Low' }),
    );
    expect(e.map((x) => x.price)).toEqual([105, 99]);
    expect(e.map((x) => x.side)).toEqual(['long', 'long']);
    expect(e.map((x) => x.createdIndex)).toEqual([0, 0]);
  });

  it('reports impulseBody as |close - open| in price units, not pips', () => {
    const e = computeLevelEvents(makeSeries([up, calm(T0 + HOUR)]), params());
    expect(e[0].impulseBody).toBeCloseTo(2, 10);
  });
});

describe('computeLevelEvents — outcomes', () => {
  const up: RawBar = { time: T0, open: 100, high: 105, low: 99, close: 102 };

  it('records the touching bar index and time on a touch', () => {
    const bars = [
      up,
      { time: T0 + HOUR, open: 103, high: 104, low: 101, close: 103 },
      { time: T0 + 2 * HOUR, open: 101, high: 104, low: 98, close: 100.5 },
      calm(T0 + 3 * HOUR),
    ];
    const e = computeLevelEvents(makeSeries(bars), params({ minGap: 1 }));
    expect(e[0].outcome).toBe('touched');
    expect(e[0].touchedIndex).toBe(2);
    expect(e[0].touchedTime).toBe(T0 + 2 * HOUR);
  });

  it('marks an expired level with no touch fields', () => {
    const nextDay = Date.UTC(2021, 8, 22, 9, 0, 0) / 1000;
    const bars = [up, calm(T0 + HOUR), calm(nextDay), calm(nextDay + HOUR)];
    const e = computeLevelEvents(makeSeries(bars), params({ maxDays: 0 }));
    expect(e[0].outcome).toBe('expired');
    expect(e[0].touchedIndex).toBeUndefined();
    expect(e[0].touchedTime).toBeUndefined();
  });

  it('leaves an unresolved level pending with no touch fields', () => {
    const e = computeLevelEvents(makeSeries([up, calm(T0 + HOUR)]), params());
    expect(e[0].outcome).toBe('pending');
    expect(e[0].touchedIndex).toBeUndefined();
    expect(e[0].touchedTime).toBeUndefined();
    expect('touchedIndex' in e[0]).toBe(false);
  });

  it('returns events in creation order', () => {
    const bars = [
      up,
      calm(T0 + HOUR),
      { time: T0 + 2 * HOUR, open: 300, high: 305, low: 299, close: 302 },
      calm(T0 + 3 * HOUR),
    ];
    const e = computeLevelEvents(makeSeries(bars), params());
    expect(e.map((x) => x.createdIndex)).toEqual([0, 2]);
  });

  it('NEVER caps: every level is returned, past Pine 500-object limit', () => {
    const n = 600;
    const bars: RawBar[] = [];
    for (let i = 0; i < n; i++) {
      const base = 100 + i * 10;
      bars.push({ time: T0 + i * HOUR, open: base, high: base + 5, low: base - 1, close: base + 2 });
    }
    const e = computeLevelEvents(makeSeries(bars), params({ maxDays: 1000, minGap: 1 }));
    expect(e).toHaveLength(n);
    expect(e.length).toBeGreaterThan(PINE_MAX_OBJECTS);
  });

  it('reuses computeBigBody param validation', () => {
    const series = makeSeries([calm(T0)]);
    expect(() => computeLevelEvents(series, params({ minGap: 0 }))).toThrow(Error);
    expect(() =>
      computeLevelEvents(series, {
        ...params(),
        levelMode: 'Nonsense' as BigBodyParams['levelMode'],
      }),
    ).toThrow(/levelMode/);
  });

  it('handles an empty series', () => {
    expect(computeLevelEvents(makeSeries([]), params())).toEqual([]);
  });
});

/**
 * REAL DATA. These read the actual CSVs under candle_data/ and are the anchor
 * for "the backtest sees exactly the strategy the chart draws". The numbers are
 * independently confirmed against a Python port of the Pine script.
 */
describe('computeLevelEvents — real candle_data (H1 and D1)', () => {
  async function load(timeframe: 'H1' | 'D1'): Promise<CandleSeries> {
    return parseCsvFile(
      path.join(process.cwd(), 'candle_data', `XAUUSDm_${timeframe}_5years.csv`),
      timeframe,
    );
  }

  function tally(events: LevelEvent[]) {
    return {
      total: events.length,
      touched: events.filter((e) => e.outcome === 'touched').length,
      expired: events.filter((e) => e.outcome === 'expired').length,
      pending: events.filter((e) => e.outcome === 'pending').length,
    };
  }

  it('H1 at default params: 871 levels, 530 touched, 339 expired, 2 pending', async () => {
    const events = computeLevelEvents(await load('H1'), DEFAULT_BIG_BODY_PARAMS);
    expect(tally(events)).toEqual({ total: 871, touched: 530, expired: 339, pending: 2 });
    expect(events.length).toBeGreaterThan(PINE_MAX_OBJECTS);
  });

  it('D1 at default params: 495 levels, 127 touched, 366 expired, 2 pending', async () => {
    const events = computeLevelEvents(await load('D1'), DEFAULT_BIG_BODY_PARAMS);
    expect(tally(events)).toEqual({ total: 495, touched: 127, expired: 366, pending: 2 });
  });

  it.each(['H1', 'D1'] as const)(
    '%s: the two outputs agree — stats from computeBigBody match the events',
    async (timeframe) => {
      const series = await load(timeframe);
      const shapes = computeBigBody(series, DEFAULT_BIG_BODY_PARAMS);
      const events = computeLevelEvents(series, DEFAULT_BIG_BODY_PARAMS);
      const t = tally(events);

      expect(shapes.stats.levelsCreated).toBe(t.total);
      expect(shapes.stats.touched).toBe(t.touched);
      expect(shapes.stats.expired).toBe(t.expired);
      expect(shapes.stats.pending).toBe(t.pending);
      expect(t.touched + t.expired + t.pending).toBe(t.total);
    },
  );

  it('H1: every event is internally consistent', async () => {
    const series = await load('H1');
    const events = computeLevelEvents(series, DEFAULT_BIG_BODY_PARAMS);

    let prev = -1;
    for (const e of events) {
      expect(e.createdIndex).toBeGreaterThanOrEqual(prev);
      prev = e.createdIndex;

      expect(e.createdTime).toBe(series.time[e.createdIndex]);
      expect(e.impulseBody).toBeCloseTo(
        Math.abs(series.close[e.createdIndex] - series.open[e.createdIndex]),
        10,
      );
      // 'Impulse origin (auto)': bullish -> level at the low, long.
      const bullish = series.close[e.createdIndex] > series.open[e.createdIndex];
      expect(e.side).toBe(bullish ? 'long' : 'short');
      expect(e.price).toBe(bullish ? series.low[e.createdIndex] : series.high[e.createdIndex]);

      if (e.outcome === 'touched') {
        const k = e.touchedIndex as number;
        expect(k).toBeGreaterThan(e.createdIndex);
        expect(e.touchedTime).toBe(series.time[k]);
        expect(series.low[k]).toBeLessThanOrEqual(e.price);
        expect(series.high[k]).toBeGreaterThanOrEqual(e.price);
      } else {
        expect(e.touchedIndex).toBeUndefined();
        expect(e.touchedTime).toBeUndefined();
      }
    }
  });
});

/* ---------- Volatility-normalised threshold modes ---------- */

/**
 * SNAPSHOT of mode `pips` taken from the implementation BEFORE the
 * threshold-mode work landed. Its only job is to fail loudly if the `pips`
 * branch ever stops being byte-for-byte what Pine did, so it covers every
 * output at once: boxes, labels, segments and events, flattened to strings so
 * a diff names the exact object that moved.
 */
const PIPS_SNAPSHOT_STATS = {
  totalBars: 40,
  bigCandles: 23,
  levelsCreated: 23,
  touched: 20,
  expired: 0,
  pending: 3,
  truncated: false,
};

const PIPS_SNAPSHOT: string[] = [
  'box 1632229200 1632232800 100.3 97.7',
  'box 1632236400 1632240000 99.1 97.3',
  'box 1632240000 1632243600 99.1 96.9',
  'box 1632247200 1632250800 99.1 96.9',
  'box 1632250800 1632254400 99.1 97.3',
  'box 1632258000 1632261600 100.3 97.7',
  'box 1632268800 1632272400 100.3 97.7',
  'box 1632276000 1632279600 99.1 97.3',
  'box 1632279600 1632283200 99.1 96.9',
  'box 1632286800 1632290400 99.1 96.9',
  'box 1632290400 1632294000 99.1 97.3',
  'box 1632297600 1632301200 100.3 97.7',
  'box 1632308400 1632312000 100.3 97.7',
  'box 1632315600 1632319200 99.1 97.3',
  'box 1632319200 1632322800 99.1 96.9',
  'box 1632326400 1632330000 99.1 96.9',
  'box 1632330000 1632333600 99.1 97.3',
  'box 1632337200 1632340800 100.3 97.7',
  'box 1632348000 1632351600 100.3 97.7',
  'box 1632355200 1632358800 99.1 97.3',
  'box 1632358800 1632362400 99.1 96.9',
  'box 1632366000 1632369600 99.1 96.9',
  'box 1632369600 1632373200 99.1 97.3',
  'label 1632229200 100.3 200 pips',
  'label 1632236400 99.1 120 pips',
  'label 1632240000 99.1 160 pips',
  'label 1632247200 99.1 160 pips',
  'label 1632250800 99.1 120 pips',
  'label 1632258000 100.3 200 pips',
  'label 1632268800 100.3 200 pips',
  'label 1632276000 99.1 120 pips',
  'label 1632279600 99.1 160 pips',
  'label 1632286800 99.1 160 pips',
  'label 1632290400 99.1 120 pips',
  'label 1632297600 100.3 200 pips',
  'label 1632308400 100.3 200 pips',
  'label 1632315600 99.1 120 pips',
  'label 1632319200 99.1 160 pips',
  'label 1632326400 99.1 160 pips',
  'label 1632330000 99.1 120 pips',
  'label 1632337200 100.3 200 pips',
  'label 1632348000 100.3 200 pips',
  'label 1632355200 99.1 120 pips',
  'label 1632358800 99.1 160 pips',
  'label 1632366000 99.1 160 pips',
  'label 1632369600 99.1 120 pips',
  'seg 1632229200 1632258000 100.3 touched',
  'seg 1632236400 1632240000 97.3 touched',
  'seg 1632240000 1632247200 99.1 touched',
  'seg 1632247200 1632279600 96.9 touched',
  'seg 1632250800 1632258000 99.1 touched',
  'seg 1632258000 1632268800 97.7 touched',
  'seg 1632268800 1632297600 100.3 touched',
  'seg 1632276000 1632279600 97.3 touched',
  'seg 1632279600 1632286800 99.1 touched',
  'seg 1632286800 1632319200 96.9 touched',
  'seg 1632290400 1632297600 99.1 touched',
  'seg 1632297600 1632308400 97.7 touched',
  'seg 1632308400 1632337200 100.3 touched',
  'seg 1632315600 1632319200 97.3 touched',
  'seg 1632319200 1632326400 99.1 touched',
  'seg 1632326400 1632358800 96.9 touched',
  'seg 1632330000 1632337200 99.1 touched',
  'seg 1632337200 1632348000 97.7 touched',
  'seg 1632348000 1632373200 100.3 pending',
  'seg 1632355200 1632358800 97.3 touched',
  'seg 1632358800 1632366000 99.1 touched',
  'seg 1632366000 1632373200 96.9 pending',
  'seg 1632369600 1632373200 99.1 pending',
  'evt 0 1632229200 100.3 short 2 touched 8 1632258000',
  'evt 2 1632236400 97.3 long 1.2 touched 3 1632240000',
  'evt 3 1632240000 99.1 short 1.6 touched 5 1632247200',
  'evt 5 1632247200 96.9 long 1.6 touched 14 1632279600',
  'evt 6 1632250800 99.1 short 1.2 touched 8 1632258000',
  'evt 8 1632258000 97.7 long 2 touched 11 1632268800',
  'evt 11 1632268800 100.3 short 2 touched 19 1632297600',
  'evt 13 1632276000 97.3 long 1.2 touched 14 1632279600',
  'evt 14 1632279600 99.1 short 1.6 touched 16 1632286800',
  'evt 16 1632286800 96.9 long 1.6 touched 25 1632319200',
  'evt 17 1632290400 99.1 short 1.2 touched 19 1632297600',
  'evt 19 1632297600 97.7 long 2 touched 22 1632308400',
  'evt 22 1632308400 100.3 short 2 touched 30 1632337200',
  'evt 24 1632315600 97.3 long 1.2 touched 25 1632319200',
  'evt 25 1632319200 99.1 short 1.6 touched 27 1632326400',
  'evt 27 1632326400 96.9 long 1.6 touched 36 1632358800',
  'evt 28 1632330000 99.1 short 1.2 touched 30 1632337200',
  'evt 30 1632337200 97.7 long 2 touched 33 1632348000',
  'evt 33 1632348000 100.3 short 2 pending - -',
  'evt 35 1632355200 97.3 long 1.2 touched 36 1632358800',
  'evt 36 1632358800 99.1 short 1.6 touched 38 1632366000',
  'evt 38 1632366000 96.9 long 1.6 pending - -',
  'evt 39 1632369600 99.1 short 1.2 pending - -',
];

/** The deterministic 40-bar series the snapshot was taken over. */
function snapshotBars(): RawBar[] {
  const bars: RawBar[] = [];
  let p = 100;
  for (let i = 0; i < 40; i++) {
    const d = ((i * 37) % 11) - 5;
    const o = p;
    const c = p + d * 0.4;
    bars.push({ time: T0 + i * HOUR, open: o, high: Math.max(o, c) + 0.3, low: Math.min(o, c) - 0.3, close: c });
    p = c;
  }
  return bars;
}

function flatten(series: CandleSeries, p: BigBodyParams): string[] {
  const r = computeBigBody(series, p);
  const n = (x: number) => String(Number(x.toFixed(10)));
  return [
    ...r.boxes.map((b) => `box ${b.time} ${b.endTime} ${n(b.top)} ${n(b.bottom)}`),
    ...r.labels.map((l) => `label ${l.time} ${n(l.price)} ${l.text}`),
    ...r.segments.map((s) => `seg ${s.time} ${s.endTime} ${n(s.price)} ${s.state}`),
    ...computeLevelEvents(series, p).map(
      (e) =>
        `evt ${e.createdIndex} ${e.createdTime} ${n(e.price)} ${e.side} ${n(e.impulseBody)} ` +
        `${e.outcome} ${e.touchedIndex ?? '-'} ${e.touchedTime ?? '-'}`,
    ),
  ];
}

describe('thresholdMode: pips is unchanged', () => {
  it('reproduces the pre-change snapshot exactly', () => {
    const series = makeSeries(snapshotBars());
    expect(flatten(series, params())).toEqual(PIPS_SNAPSHOT);
    expect(computeBigBody(series, params()).stats).toEqual(PIPS_SNAPSHOT_STATS);
  });

  it('an explicit thresholdMode: pips is the same as the default', () => {
    const series = makeSeries(snapshotBars());
    expect(flatten(series, params({ thresholdMode: 'pips' }))).toEqual(PIPS_SNAPSHOT);
  });

  it('percent/atr params are ignored in pips mode, however absurd', () => {
    const series = makeSeries(snapshotBars());
    expect(
      flatten(series, params({ thresholdPercent: 0.0001, atrPeriod: 2, atrMultiple: 0.01 })),
    ).toEqual(PIPS_SNAPSHOT);
  });
});

describe('thresholdMode: percent', () => {
  const pct = (over: Partial<BigBodyParams> = {}) =>
    params({ thresholdMode: 'percent', thresholdPercent: 0.5, ...over });

  it('fires when the body is EXACTLY thresholdPercent of the close', () => {
    // 0.5% of 100 is 0.5, and the body is 0.5. `>=`, so this must qualify.
    const bars = [{ time: T0, open: 99.5, high: 100.2, low: 99.4, close: 100 }, calm(T0 + HOUR)];
    expect(computeBigBody(makeSeries(bars), pct()).stats.bigCandles).toBe(1);
  });

  it('does not fire a hair below the threshold', () => {
    const bars = [{ time: T0, open: 99.51, high: 100.2, low: 99.4, close: 100 }, calm(T0 + HOUR)];
    expect(computeBigBody(makeSeries(bars), pct()).stats.bigCandles).toBe(0);
  });

  it('is measured against THAT bar close, so the same body qualifies at a lower price', () => {
    // Identical 0.5 body; at close 100 it is 0.5%, at close 200 it is 0.25%.
    const bars = [
      { time: T0, open: 99.5, high: 100.2, low: 99.4, close: 100 },
      { time: T0 + HOUR, open: 199.5, high: 200.2, low: 199.4, close: 200 },
    ];
    const r = computeBigBody(makeSeries(bars), pct());
    expect(r.stats.bigCandles).toBe(1);
    expect(r.boxes[0].time).toBe(T0);
  });

  it('ignores thresholdPips entirely', () => {
    const bars = [{ time: T0, open: 99.5, high: 100.2, low: 99.4, close: 100 }, calm(T0 + HOUR)];
    // 0.5 body at pip 0.01 is 50 pips, far under a 100-pip pips threshold.
    expect(computeBigBody(makeSeries(bars), pct({ thresholdPips: 100 })).stats.bigCandles).toBe(1);
  });

  it('a down candle is measured on |close - open| just the same', () => {
    const bars = [{ time: T0, open: 100.5, high: 100.6, low: 99.9, close: 100 }, calm(T0 + HOUR)];
    // body 0.5, close 100 -> exactly 0.5%.
    expect(computeBigBody(makeSeries(bars), pct()).stats.bigCandles).toBe(1);
  });

  it('still creates levels through the normal state machine', () => {
    const bars = [
      { time: T0, open: 99.5, high: 100.2, low: 99.4, close: 100 },
      { time: T0 + HOUR, open: 100, high: 100.1, low: 99.3, close: 99.9 },
    ];
    const events = computeLevelEvents(makeSeries(bars), pct());
    expect(events).toHaveLength(1);
    expect(events[0].side).toBe('long');
    expect(events[0].price).toBe(99.4);
    expect(events[0].outcome).toBe('touched');
  });
});

/**
 * ATR fixture, worked out by hand. period = 3, multiple = 1.
 *
 *  i  o    c    h    l    body  prevC  TR                      ATR
 *  0  8    10   10   8    2     -      10-8 = 2                seeding
 *  1  9    11   11   9    2     10     max(2, 1, 1) = 2        seeding
 *  2  10   12   12   10   2     11     max(2, 1, 1) = 2        seed = 6/3 = 2
 *  3  10   13   15   10   3     12     max(5, 3, 2) = 5        (2*2+5)/3 = 3
 *  4  13   14   16   13   1     13     max(3, 3, 0) = 3        (3*2+3)/3 = 3
 *  5  14   20   20   14   6     14     max(6, 6, 0) = 6        (3*2+6)/3 = 4
 *
 * Bars 0..2 carry a body of 2, which WOULD clear the seed of 2 — they must
 * still not be big, because no ATR is published before index `atrPeriod`.
 * Bar 3 has body 3 against ATR 3: the boundary, inclusive. Bar 4 is under.
 */
const ATR_BARS: RawBar[] = [
  { time: T0 + 0 * HOUR, open: 8, high: 10, low: 8, close: 10 },
  { time: T0 + 1 * HOUR, open: 9, high: 11, low: 9, close: 11 },
  { time: T0 + 2 * HOUR, open: 10, high: 12, low: 10, close: 12 },
  { time: T0 + 3 * HOUR, open: 10, high: 15, low: 10, close: 13 },
  { time: T0 + 4 * HOUR, open: 13, high: 16, low: 13, close: 14 },
  { time: T0 + 5 * HOUR, open: 14, high: 20, low: 14, close: 20 },
];

describe('wilderAtr', () => {
  it('matches the hand-computed series', () => {
    const atr = wilderAtr(makeSeries(ATR_BARS), 3);
    expect(atr).toHaveLength(6);
    expect(Number.isNaN(atr[0])).toBe(true);
    expect(Number.isNaN(atr[1])).toBe(true);
    expect(Number.isNaN(atr[2])).toBe(true);
    expect(atr[3]).toBeCloseTo(3, 12);
    expect(atr[4]).toBeCloseTo(3, 12);
    expect(atr[5]).toBeCloseTo(4, 12);
  });

  it('publishes nothing until the seed window has closed', () => {
    const atr = wilderAtr(makeSeries(ATR_BARS), 3);
    for (let i = 0; i < 3; i++) expect(Number.isNaN(atr[i])).toBe(true);
    for (let i = 3; i < 6; i++) expect(Number.isFinite(atr[i])).toBe(true);
  });

  it('is all-NaN when the series is shorter than the seed window', () => {
    const atr = wilderAtr(makeSeries(ATR_BARS.slice(0, 3)), 3);
    expect([...atr].every(Number.isNaN)).toBe(true);
  });

  it('is strictly causal: truncating the series changes no earlier value', () => {
    const full = wilderAtr(makeSeries(ATR_BARS), 3);
    for (let cut = 1; cut <= ATR_BARS.length; cut++) {
      const prefix = wilderAtr(makeSeries(ATR_BARS.slice(0, cut)), 3);
      expect(prefix).toHaveLength(cut);
      for (let i = 0; i < cut; i++) {
        if (Number.isNaN(full[i])) expect(Number.isNaN(prefix[i])).toBe(true);
        else expect(prefix[i]).toBeCloseTo(full[i], 12);
      }
    }
  });

  it('is causal on real data too — a 5000-bar prefix has the same ATRs', async () => {
    const series = await parseCsvFile(
      path.join(process.cwd(), 'candle_data', 'XAUUSDm_H1_5years.csv'),
      'H1',
    );
    const full = wilderAtr(series, 14);
    const cut = 5000;
    const head: CandleSeries = { ...series, count: cut };
    const prefix = wilderAtr(head, 14);
    for (let i = 0; i < cut; i++) {
      if (Number.isNaN(full[i])) expect(Number.isNaN(prefix[i])).toBe(true);
      else expect(prefix[i]).toBe(full[i]);
    }
  });
});

describe('thresholdMode: atr', () => {
  const atrP = (over: Partial<BigBodyParams> = {}) =>
    params({ thresholdMode: 'atr', atrPeriod: 3, atrMultiple: 1, ...over });

  it('never fires before the seed window closes, even on a body that clears the seed', () => {
    const r = computeBigBody(makeSeries(ATR_BARS), atrP());
    expect(r.stats.bigCandles).toBe(2);
    expect(r.boxes.map((b) => b.time)).toEqual([T0 + 3 * HOUR, T0 + 5 * HOUR]);
  });

  it('is inclusive at the boundary and exclusive below it', () => {
    // bar 3: body 3 vs ATR 3 -> big. bar 4: body 1 vs ATR 3 -> not big.
    const times = computeBigBody(makeSeries(ATR_BARS), atrP()).boxes.map((b) => b.time);
    expect(times).toContain(T0 + 3 * HOUR);
    expect(times).not.toContain(T0 + 4 * HOUR);
  });

  it('atrMultiple scales the bar', () => {
    // x2: bar 3 needs body >= 6 (has 3, out), bar 5 needs >= 8 (has 6, out).
    expect(computeBigBody(makeSeries(ATR_BARS), atrP({ atrMultiple: 2 })).stats.bigCandles).toBe(0);
    // x0.5: bar 3 >= 1.5 (yes), bar 4 >= 1.5 (body 1, no), bar 5 >= 2 (yes).
    expect(computeBigBody(makeSeries(ATR_BARS), atrP({ atrMultiple: 0.5 })).stats.bigCandles).toBe(2);
  });

  it('produces no big candles at all when the series never seeds', () => {
    expect(computeBigBody(makeSeries(ATR_BARS), atrP({ atrPeriod: 20 })).stats.bigCandles).toBe(0);
  });

  it('ignores thresholdPips and thresholdPercent', () => {
    const r = computeBigBody(
      makeSeries(ATR_BARS),
      atrP({ thresholdPips: 1e9, thresholdPercent: 99 }),
    );
    expect(r.stats.bigCandles).toBe(2);
  });
});

describe('thresholdMode — param validation', () => {
  const series = makeSeries([calm(T0)]);

  it('throws on an unknown thresholdMode', () => {
    expect(() =>
      computeBigBody(series, {
        ...params(),
        thresholdMode: 'zscore' as BigBodyParams['thresholdMode'],
      }),
    ).toThrow(/thresholdMode/);
  });

  const bad: Array<[string, Partial<BigBodyParams>]> = [
    ['thresholdPercent = 0', { thresholdMode: 'percent', thresholdPercent: 0 }],
    ['thresholdPercent < 0', { thresholdMode: 'percent', thresholdPercent: -1 }],
    ['thresholdPercent NaN', { thresholdMode: 'percent', thresholdPercent: NaN }],
    ['atrPeriod = 0', { thresholdMode: 'atr', atrPeriod: 0 }],
    ['atrPeriod fractional', { thresholdMode: 'atr', atrPeriod: 2.5 }],
    ['atrPeriod NaN', { thresholdMode: 'atr', atrPeriod: NaN }],
    ['atrMultiple = 0', { thresholdMode: 'atr', atrMultiple: 0 }],
    ['atrMultiple < 0', { thresholdMode: 'atr', atrMultiple: -1 }],
  ];
  for (const [name, over] of bad) {
    it(`throws on ${name}`, () => {
      expect(() => computeBigBody(series, params(over))).toThrow(Error);
    });
  }

  it('validates only what the active mode uses', () => {
    // A junk thresholdPips must not block a percent run, and junk percent/atr
    // params must not block a pips run.
    expect(() =>
      computeBigBody(series, params({ thresholdMode: 'percent', thresholdPips: -1 })),
    ).not.toThrow();
    expect(() =>
      computeBigBody(series, params({ thresholdMode: 'percent', atrPeriod: 0, atrMultiple: -1 })),
    ).not.toThrow();
    expect(() =>
      computeBigBody(series, params({ thresholdMode: 'atr', thresholdPips: NaN, thresholdPercent: 0 })),
    ).not.toThrow();
    expect(() =>
      computeBigBody(series, params({ thresholdMode: 'pips', thresholdPercent: 0, atrPeriod: 0 })),
    ).not.toThrow();
  });
});

describe('thresholdMode — real candle_data', () => {
  it('percent at 0.5% on H1: 1168 big candles, spread across the years', async () => {
    const series = await parseCsvFile(
      path.join(process.cwd(), 'candle_data', 'XAUUSDm_H1_5years.csv'),
      'H1',
    );
    const events = computeLevelEvents(series, {
      ...DEFAULT_BIG_BODY_PARAMS,
      thresholdMode: 'percent',
      thresholdPercent: 0.5,
    });
    // 'Impulse origin (auto)' makes exactly one level per big candle.
    expect(events).toHaveLength(1168);

    const byYear: Record<string, number> = {};
    for (const e of events) {
      const y = String(new Date(e.createdTime * 1000).getUTCFullYear());
      byYear[y] = (byYear[y] ?? 0) + 1;
    }
    // Contrast with the fixed-pip counts (3, 16, 13, 30, 222, 587): the last
    // year is no longer two thirds of the sample.
    expect(byYear).toEqual({
      '2021': 33,
      '2022': 154,
      '2023': 112,
      '2024': 125,
      '2025': 285,
      '2026': 459,
    });
  });

  it('atr mode on H1 produces a similarly spread sample, and never before the seed', async () => {
    const series = await parseCsvFile(
      path.join(process.cwd(), 'candle_data', 'XAUUSDm_H1_5years.csv'),
      'H1',
    );
    const events = computeLevelEvents(series, {
      ...DEFAULT_BIG_BODY_PARAMS,
      thresholdMode: 'atr',
      atrPeriod: 14,
      atrMultiple: 1,
    });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.createdIndex).toBeGreaterThanOrEqual(14);

    const years = new Set(events.map((e) => new Date(e.createdTime * 1000).getUTCFullYear()));
    expect([...years].sort()).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
  });
});
