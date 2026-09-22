import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Wrap the real parser so we can count how many times a cold timeframe is parsed.
const spy = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('./parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./parser')>();
  return {
    ...actual,
    parseCsvFile: async (filePath: string, timeframe: never) => {
      spy.calls.push(timeframe);
      // A little latency so concurrent callers genuinely overlap.
      await new Promise((r) => setTimeout(r, 25));
      return actual.parseCsvFile(filePath, timeframe);
    },
  };
});

import {
  getPage,
  getSeries,
  indexAtOrBefore,
  listTimeframes,
  MissingTimeframeError,
  truncateSeries,
} from './store';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, TIMEFRAMES } from './types';

const FIXTURES = path.join(__dirname, '__fixtures__');
let bigDir = '';

beforeAll(() => {
  process.env.CANDLE_DATA_DIR = FIXTURES;

  // MAX_PAGE_SIZE clamping needs more bars than MAX_PAGE_SIZE. That file is ~1.6 MB,
  // too big to keep as a checked-in fixture, so it is generated into a temp dir.
  bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'candles-big-'));
  const rows = ['time,open,high,low,close,tick_volume,spread,real_volume'];
  const base = Date.UTC(2023, 0, 2, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  for (let i = 0; i < MAX_PAGE_SIZE + 50; i++) {
    const d = new Date(base + i * 30 * 60_000);
    const ts =
      `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    rows.push(`${ts},${(2000 + i).toFixed(8)},${(2001 + i).toFixed(8)},${(1999 + i).toFixed(8)},${(2000.5 + i).toFixed(8)},${i},200,0`);
  }
  fs.writeFileSync(path.join(bigDir, 'XAUUSDm_M30_5years.csv'), `${rows.join('\n')}\n`);
});

afterEach(() => {
  process.env.CANDLE_DATA_DIR = FIXTURES;
});

afterAll(() => {
  fs.rmSync(bigDir, { recursive: true, force: true });
});

describe('getPage', () => {
  it('returns the tail of the series when `before` is omitted', async () => {
    const page = await getPage('H1', { limit: 5 });
    expect(page.timeframe).toBe('H1');
    expect(page.totalBars).toBe(25);
    expect(page.bars).toHaveLength(5);
    expect(page.startIndex).toBe(20);
    expect(page.hasMore).toBe(true);
    expect(page.hasNewer).toBe(false);

    // Oldest -> newest.
    expect(page.bars[0].time).toBe(Date.UTC(2022, 0, 3, 20) / 1000);
    expect(page.bars[4].time).toBe(Date.UTC(2022, 0, 3, 24) / 1000);
    expect(page.bars[0].open).toBeCloseTo(2020, 9);
    expect(page.bars[4].volume).toBe(124);
  });

  it('defaults limit to DEFAULT_PAGE_SIZE', async () => {
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThan(25);
    const page = await getPage('H1', {});
    expect(page.bars).toHaveLength(25);
    expect(page.startIndex).toBe(0);
    expect(page.hasMore).toBe(false);
    expect(page.hasNewer).toBe(false);
  });

  it('treats `before` as an exclusive index', async () => {
    const page = await getPage('H1', { before: 10, limit: 5 });
    expect(page.startIndex).toBe(5);
    expect(page.bars).toHaveLength(5);
    expect(page.bars[0].time).toBe(Date.UTC(2022, 0, 3, 5) / 1000);
    expect(page.bars[4].time).toBe(Date.UTC(2022, 0, 3, 9) / 1000);
    expect(page.hasMore).toBe(true);
    expect(page.hasNewer).toBe(true);
  });

  it('clamps at the start of the series', async () => {
    const page = await getPage('H1', { before: 3, limit: 3000 });
    expect(page.bars).toHaveLength(3);
    expect(page.startIndex).toBe(0);
    expect(page.hasMore).toBe(false);
    expect(page.hasNewer).toBe(true);
    expect(page.bars[0].time).toBe(Date.UTC(2022, 0, 3, 0) / 1000);
  });

  it('clamps a `before` beyond totalBars to the end instead of erroring', async () => {
    const page = await getPage('H1', { before: 999_999, limit: 5 });
    expect(page.startIndex).toBe(20);
    expect(page.bars).toHaveLength(5);
    expect(page.bars[4].time).toBe(Date.UTC(2022, 0, 3, 24) / 1000);
    expect(page.hasNewer).toBe(false);
  });

  it('clamps limit to MAX_PAGE_SIZE', async () => {
    process.env.CANDLE_DATA_DIR = bigDir;
    const page = await getPage('M30', { limit: MAX_PAGE_SIZE * 10 });
    expect(page.totalBars).toBe(MAX_PAGE_SIZE + 50);
    expect(page.bars).toHaveLength(MAX_PAGE_SIZE);
    expect(page.startIndex).toBe(50);
    expect(page.hasMore).toBe(true);
  });

  it('rejects a non-positive or non-finite limit', async () => {
    await expect(getPage('H1', { limit: 0 })).rejects.toThrow(RangeError);
    await expect(getPage('H1', { limit: -5 })).rejects.toThrow(RangeError);
    await expect(getPage('H1', { limit: Number.NaN })).rejects.toThrow(RangeError);
  });

  it('throws MissingTimeframeError when the CSV is absent', async () => {
    const err = await getPage('W1', { limit: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingTimeframeError);
    expect(err).toBeInstanceOf(Error);
    expect((err as MissingTimeframeError).timeframe).toBe('W1');
  });

  it('parses a cold timeframe exactly once under concurrent requests', async () => {
    spy.calls.length = 0;
    const pages = await Promise.all([
      getPage('M2', { limit: 2 }),
      getPage('M2', { limit: 3 }),
      getPage('M2', { limit: 5 }),
      getPage('M2', {}),
    ]);
    expect(spy.calls.filter((tf) => tf === 'M2')).toHaveLength(1);
    expect(pages[0].bars).toHaveLength(2);
    expect(pages[3].totalBars).toBe(5);

    // Still one after the cache has resolved.
    await getPage('M2', { limit: 1 });
    expect(spy.calls.filter((tf) => tf === 'M2')).toHaveLength(1);
  });
});

/** The H1 fixture: 25 bars, one per hour from 2022.01.03 00:00; index i is hour i. */
const H1_TIME = (hour: number) => Date.UTC(2022, 0, 3, hour) / 1000;
const H1_TOTAL = 25;

type PageOpts = Parameters<typeof getPage>[1];

describe('getPage `until`', () => {
  it('ends the page at the bar whose time equals `until`', async () => {
    const page = await getPage('H1', { until: H1_TIME(10), limit: 5 });
    expect(page.startIndex).toBe(6);
    expect(page.bars).toHaveLength(5);
    expect(page.bars[0].time).toBe(H1_TIME(6));
    expect(page.bars[4].time).toBe(H1_TIME(10));
    expect(page.totalBars).toBe(H1_TOTAL);
    expect(page.hasMore).toBe(true);
    expect(page.hasNewer).toBe(true);
  });

  it('ends the page at the last bar before `until` when it falls between bars', async () => {
    // 10:30 — bar 10 (10:00) is the last bar at or before it; bar 11 (11:00) is not.
    const page = await getPage('H1', { until: H1_TIME(10) + 30 * 60, limit: 5 });
    expect(page.startIndex).toBe(6);
    expect(page.bars).toHaveLength(5);
    expect(page.bars[4].time).toBe(H1_TIME(10));
    expect(page.hasNewer).toBe(true);
  });

  it('throws a plain Error naming the first bar when `until` precedes the series', async () => {
    const err = await getPage('H1', { until: H1_TIME(0) - 1, limit: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Plain `Error`, not a subclass: the route maps exactly that to a 400.
    expect((err as Error).constructor).toBe(Error);
    expect((err as Error).message).toContain(String(H1_TIME(0)));
  });

  it('returns the tail when `until` is after the last bar', async () => {
    const page = await getPage('H1', { until: H1_TIME(24) + 7 * 86_400, limit: 5 });
    expect(page.startIndex).toBe(20);
    expect(page.bars).toHaveLength(5);
    expect(page.bars[4].time).toBe(H1_TIME(24));
    expect(page.hasMore).toBe(true);
    expect(page.hasNewer).toBe(false);
  });

  it('reports no newer bars when `until` is exactly the last bar', async () => {
    const page = await getPage('H1', { until: H1_TIME(24), limit: 3 });
    expect(page.startIndex).toBe(22);
    expect(page.bars.map((b) => b.time)).toEqual([H1_TIME(22), H1_TIME(23), H1_TIME(24)]);
    expect(page.hasNewer).toBe(false);
  });

  it('clamps at the start of the series when `limit` exceeds the bars available', async () => {
    const page = await getPage('H1', { until: H1_TIME(2), limit: 10 });
    expect(page.startIndex).toBe(0);
    expect(page.bars).toHaveLength(3);
    expect(page.bars[0].time).toBe(H1_TIME(0));
    expect(page.bars[2].time).toBe(H1_TIME(2));
    expect(page.hasMore).toBe(false);
    expect(page.hasNewer).toBe(true);
  });
});

describe('getPage `after`', () => {
  it('starts just after the given index', async () => {
    const page = await getPage('H1', { after: 9, limit: 5 });
    expect(page.startIndex).toBe(10);
    expect(page.bars).toHaveLength(5);
    expect(page.bars[0].time).toBe(H1_TIME(10));
    expect(page.bars[4].time).toBe(H1_TIME(14));
    expect(page.totalBars).toBe(H1_TOTAL);
    expect(page.hasMore).toBe(true);
    expect(page.hasNewer).toBe(true);
  });

  it('steps forward exactly one bar with limit=1', async () => {
    const page = await getPage('H1', { after: 10, limit: 1 });
    expect(page.startIndex).toBe(11);
    expect(page.bars.map((b) => b.time)).toEqual([H1_TIME(11)]);
    expect(page.hasNewer).toBe(true);
  });

  it('returns an empty page with hasNewer=false at the last index', async () => {
    const page = await getPage('H1', { after: H1_TOTAL - 1, limit: 5 });
    expect(page.bars).toEqual([]);
    expect(page.startIndex).toBe(H1_TOTAL);
    expect(page.totalBars).toBe(H1_TOTAL);
    expect(page.hasNewer).toBe(false);
  });

  it('returns an empty page with hasNewer=false beyond the end instead of throwing', async () => {
    const page = await getPage('H1', { after: 999_999, limit: 5 });
    expect(page.bars).toEqual([]);
    expect(page.startIndex).toBe(H1_TOTAL);
    expect(page.hasNewer).toBe(false);
  });

  it('returns only the remainder when `limit` exceeds the bars left', async () => {
    const page = await getPage('H1', { after: 20, limit: 100 });
    expect(page.startIndex).toBe(21);
    expect(page.bars.map((b) => b.time)).toEqual([
      H1_TIME(21), H1_TIME(22), H1_TIME(23), H1_TIME(24),
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.hasNewer).toBe(false);
  });

  it('rejects a non-finite `after` or `until`', async () => {
    await expect(getPage('H1', { after: Number.NaN })).rejects.toThrow(RangeError);
    await expect(getPage('H1', { until: Number.POSITIVE_INFINITY })).rejects.toThrow(RangeError);
  });
});

describe('getPage paging modes are mutually exclusive', () => {
  const cases: PageOpts[] = [
    { before: 10, after: 10 },
    { before: 10, until: H1_TIME(10) },
    { after: 10, until: H1_TIME(10) },
    { before: 10, after: 10, until: H1_TIME(10) },
  ];
  for (const opts of cases) {
    it(`throws a plain Error naming the params for ${Object.keys(opts).join('+')}`, async () => {
      const err = await getPage('H1', { ...opts, limit: 5 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).constructor).toBe(Error);
      for (const name of Object.keys(opts)) expect((err as Error).message).toContain(name);
    });
  }
});

describe('indexAtOrBefore', () => {
  it('returns the largest index whose time is <= the target', async () => {
    const s = await getSeries('H1');
    expect(indexAtOrBefore(s, H1_TIME(10))).toBe(10); // exact
    expect(indexAtOrBefore(s, H1_TIME(10) + 1)).toBe(10); // just after 10
    expect(indexAtOrBefore(s, H1_TIME(11) - 1)).toBe(10); // just before 11
    expect(indexAtOrBefore(s, H1_TIME(0))).toBe(0); // first bar exactly
    expect(indexAtOrBefore(s, H1_TIME(0) - 1)).toBe(-1); // before the first bar
    expect(indexAtOrBefore(s, H1_TIME(24))).toBe(24); // last bar exactly
    expect(indexAtOrBefore(s, H1_TIME(24) + 1)).toBe(24); // after the last bar
    expect(indexAtOrBefore(s, H1_TIME(24) + 365 * 86_400)).toBe(24);
  });

  it('returns -1 for an empty series', async () => {
    const s = await getSeries('H1');
    expect(indexAtOrBefore(truncateSeries(s, 0), H1_TIME(10))).toBe(-1);
  });

  it('agrees with a linear scan at, just after and just before every bar', async () => {
    const s = await getSeries('H1');
    for (let i = 0; i < s.count; i++) {
      expect(indexAtOrBefore(s, s.time[i])).toBe(i);
      expect(indexAtOrBefore(s, s.time[i] + 1)).toBe(i);
      expect(indexAtOrBefore(s, s.time[i] - 1)).toBe(i - 1);
    }
  });
});

describe('truncateSeries', () => {
  const COLUMNS = ['time', 'open', 'high', 'low', 'close', 'volume', 'spread'] as const;

  it('returns a zero-copy view of the first `count` bars', async () => {
    const s = await getSeries('H1');
    const v = truncateSeries(s, 10);
    expect(v.timeframe).toBe('H1');
    expect(v.count).toBe(10);
    expect(v.skippedRows).toBe(s.skippedRows);
    for (const col of COLUMNS) {
      expect(v[col]).toHaveLength(10);
      // A view over the store's memory, not a copy.
      expect(v[col].buffer).toBe(s[col].buffer);
    }
    expect(v.time[9]).toBe(H1_TIME(9));
    expect(v.time[10]).toBeUndefined();
    expect(v.close[9]).toBeCloseTo(2009.5, 9);
    // The original is untouched.
    expect(s.count).toBe(H1_TOTAL);
    expect(s.time).toHaveLength(H1_TOTAL);
  });

  it('clamps `count` to [0, series.count]', async () => {
    const s = await getSeries('H1');
    expect(truncateSeries(s, 999).count).toBe(H1_TOTAL);
    expect(truncateSeries(s, 999).time).toHaveLength(H1_TOTAL);
    expect(truncateSeries(s, -3).count).toBe(0);
    expect(truncateSeries(s, -3).time).toHaveLength(0);
    expect(truncateSeries(s, 2.7).count).toBe(2);
  });
});

describe('listTimeframes', () => {
  it('never triggers a parse and reports cheap metadata', async () => {
    spy.calls.length = 0;
    const infos = await listTimeframes();
    expect(spy.calls).toHaveLength(0);

    expect(infos.map((i) => i.timeframe)).toEqual([...TIMEFRAMES]);

    const m15 = infos.find((i) => i.timeframe === 'M15');
    expect(m15).toBeDefined();
    expect(m15!.loaded).toBe(false);
    // Exact bar count is not derivable without a full parse.
    expect(m15!.totalBars).toBeNull();
    expect(m15!.firstTime).toBe(Date.UTC(2022, 0, 7, 23, 15) / 1000);
    expect(m15!.lastTime).toBe(Date.UTC(2022, 0, 10, 1, 15) / 1000);
  });

  it('reports real values for a loaded timeframe', async () => {
    await getPage('M1', { limit: 1 });
    const infos = await listTimeframes();
    const m1 = infos.find((i) => i.timeframe === 'M1');
    expect(m1!.loaded).toBe(true);
    expect(m1!.totalBars).toBe(10);
    expect(m1!.firstTime).toBe(1632226680);
    expect(m1!.lastTime).toBe(1632226680 + 9 * 60);
  });

  it('reports all-nulls for a missing timeframe', async () => {
    const infos = await listTimeframes();
    const w1 = infos.find((i) => i.timeframe === 'W1');
    expect(w1).toEqual({
      timeframe: 'W1',
      totalBars: null,
      firstTime: null,
      lastTime: null,
      loaded: false,
    });
  });
});
