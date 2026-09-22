import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import path from 'node:path';
import { bigBodyCacheKey, getBigBody } from './cache';
import { DEFAULT_BIG_BODY_PARAMS, type BigBodyParams } from './types';

// Guards the bug where a param changed the result but not the cache key, so
// the indicator served the previous answer and the new setting looked inert.
describe('bigBodyCacheKey covers every param that changes the result', () => {
  const base: BigBodyParams = DEFAULT_BIG_BODY_PARAMS;

  const variants: Array<[string, Partial<BigBodyParams>]> = [
    ['thresholdMode', { thresholdMode: 'percent' }],
    ['thresholdPips', { thresholdPips: 1500 }],
    ['thresholdPercent', { thresholdPercent: 0.9 }],
    ['atrPeriod', { atrPeriod: 21 }],
    ['atrMultiple', { atrMultiple: 2 }],
    ['autoPip', { autoPip: true }],
    ['manualPip', { manualPip: 0.1 }],
    ['frameFull', { frameFull: false }],
    ['showLabel', { showLabel: false }],
    ['levelMode', { levelMode: 'High & Low' }],
    ['maxDays', { maxDays: 3 }],
    ['minGap', { minGap: 5 }],
  ];

  for (const [name, override] of variants) {
    it(`changes when ${name} changes`, () => {
      expect(bigBodyCacheKey('H1', { ...base, ...override }))
        .not.toBe(bigBodyCacheKey('H1', base));
    });
  }

  it('changes when the timeframe changes', () => {
    expect(bigBodyCacheKey('H1', base)).not.toBe(bigBodyCacheKey('H4', base));
  });

  it('is stable for identical params', () => {
    expect(bigBodyCacheKey('H1', { ...base })).toBe(bigBodyCacheKey('H1', { ...base }));
  });
});

// Replay truncates the series at `until`; a key that ignored it would hand a
// replay the full-series levels, i.e. levels created by candles it hides.
describe('bigBodyCacheKey and `until`', () => {
  const base: BigBodyParams = DEFAULT_BIG_BODY_PARAMS;

  it('is unchanged when `until` is absent, so existing entries stay valid', () => {
    expect(bigBodyCacheKey('H1', base, undefined)).toBe(bigBodyCacheKey('H1', base));
  });

  it('changes when `until` is given, and between two different `until`s', () => {
    expect(bigBodyCacheKey('H1', base, 1_700_000_000)).not.toBe(bigBodyCacheKey('H1', base));
    expect(bigBodyCacheKey('H1', base, 1_700_000_000))
      .not.toBe(bigBodyCacheKey('H1', base, 1_700_003_600));
  });
});

describe('getBigBody with `until`', () => {
  // The H1 fixture: 25 bars, one per hour from 2022.01.03 00:00; index i is hour i.
  const H1_TIME = (hour: number) => Date.UTC(2022, 0, 3, hour) / 1000;
  const FIXTURES = path.join(__dirname, '..', 'candles', '__fixtures__');
  let previousDir: string | undefined;

  beforeAll(() => {
    previousDir = process.env.CANDLE_DATA_DIR;
    process.env.CANDLE_DATA_DIR = FIXTURES;
  });
  afterAll(() => {
    if (previousDir === undefined) delete process.env.CANDLE_DATA_DIR;
    else process.env.CANDLE_DATA_DIR = previousDir;
  });

  it('computes over the whole series when `until` is absent', async () => {
    const full = await getBigBody('H1', DEFAULT_BIG_BODY_PARAMS);
    expect(full.stats.totalBars).toBe(25);
  });

  it('computes over the series truncated at the last bar <= until', async () => {
    // 10:30 -> bars 0..10 are visible, so 11 bars.
    const cut = await getBigBody('H1', DEFAULT_BIG_BODY_PARAMS, H1_TIME(10) + 30 * 60);
    expect(cut.stats.totalBars).toBe(11);
    for (const shape of [...cut.boxes, ...cut.labels, ...cut.segments]) {
      expect(shape.time).toBeLessThanOrEqual(H1_TIME(10));
    }
    // An exact bar time includes that bar.
    const exact = await getBigBody('H1', DEFAULT_BIG_BODY_PARAMS, H1_TIME(4));
    expect(exact.stats.totalBars).toBe(5);
  });

  it('throws a plain Error when no bar is <= until', async () => {
    const err = await getBigBody('H1', DEFAULT_BIG_BODY_PARAMS, H1_TIME(0) - 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).constructor).toBe(Error);
    expect((err as Error).message).toContain(String(H1_TIME(0)));
  });
});
