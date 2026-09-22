/**
 * The in-memory candle store: the only module the rest of the app should talk to
 * for candle data. Lazily parses a timeframe's CSV on first request and keeps it
 * in memory for the process lifetime.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseCsvFile } from './parser';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SYMBOL,
  TIMEFRAMES,
  type Bar,
  type CandlePage,
  type CandleSeries,
  type Timeframe,
  type TimeframeInfo,
} from './types';

export class MissingTimeframeError extends Error {
  readonly timeframe: Timeframe;

  constructor(timeframe: Timeframe, filePath: string) {
    super(`No candle data for timeframe ${timeframe} (expected ${filePath})`);
    this.name = 'MissingTimeframeError';
    this.timeframe = timeframe;
    // Keeps `instanceof` working when this is compiled down to ES5-style classes.
    Object.setPrototypeOf(this, MissingTimeframeError.prototype);
  }
}

/**
 * The cache lives on globalThis, not in a module-level variable.
 *
 * Next.js dev replaces the module registry on every hot reload, so a module-level
 * Map would be dropped and the 141 MB M1 file would be re-parsed on every source
 * edit. A symbol-keyed property on globalThis outlives module re-evaluation, so
 * an edit costs nothing.
 *
 * Keyed by absolute file path rather than by timeframe so that changing
 * CANDLE_DATA_DIR (tests pointing at fixtures) can never serve stale data from a
 * different directory.
 *
 * Values are Promises, stored the moment a parse starts. Concurrent requests for
 * the same cold timeframe therefore await the same in-flight parse instead of
 * each kicking off their own.
 */
/**
 * Bump when the SHAPE **or the MEANING** of a cached value changes.
 *
 * These caches deliberately live on `globalThis` so Next's dev hot-reload does
 * not re-parse 141 MB on every edit — but that also means a stale object
 * outlives the code that produced it. Adding the `spread` column to
 * `CandleSeries` once left the dev server serving series with no `spread`
 * field, which surfaced as `Cannot read properties of undefined` from deep
 * inside the backtest rather than as anything resembling a schema problem.
 *
 * Versioning the key makes such a change invalidate the cache instead.
 *
 * SEMANTICS COUNT TOO, and that is the easier one to forget. Fixing the
 * entry-bar look-ahead in `simulate.ts` altered every stored result without
 * altering a single type, so the dev server happily served the pre-fix numbers
 * from a sweep that reported completing in 0.0s. If you change how a cached
 * value is COMPUTED, bump this.
 */
const CACHE_SCHEMA_VERSION = 4;

const CACHE_KEY = Symbol.for(`candles.seriesCache.v${CACHE_SCHEMA_VERSION}`);

/**
 * One cache entry. `promise` is set the instant a parse starts; `series` is filled
 * in when it resolves, which gives listTimeframes a synchronous "is it loaded yet?"
 * check without awaiting (and therefore without reporting `loaded: true` for a
 * parse that is still running).
 */
interface CacheEntry {
  promise: Promise<CandleSeries>;
  series?: CandleSeries;
}

type Cache = Map<string, CacheEntry>;

function cache(): Cache {
  const g = globalThis as typeof globalThis & { [CACHE_KEY]?: Cache };
  if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map<string, CacheEntry>();
  return g[CACHE_KEY];
}

/**
 * Data directory. `process.cwd()` is the Next.js project root at runtime;
 * CANDLE_DATA_DIR overrides it (tests point it at __fixtures__). Read on every
 * call, not at module load, so the override can change between calls.
 */
function dataDir(): string {
  return process.env.CANDLE_DATA_DIR || path.join(process.cwd(), 'candle_data');
}

function filePathFor(timeframe: Timeframe): string {
  return path.join(dataDir(), `${SYMBOL}_${timeframe}_5years.csv`);
}

/**
 * The whole parsed series for a timeframe, sharing the store's parse cache.
 *
 * `getPage` caps at `MAX_PAGE_SIZE`, so consumers that genuinely need every
 * bar (indicators, and later the backtest engine) would otherwise have to
 * reassemble the series page by page — allocating a second full copy and
 * churning one `Bar` object per row. They get the store's own arrays instead.
 *
 * The returned arrays are the cached instances: treat them as read-only.
 */
export async function getSeries(timeframe: Timeframe): Promise<CandleSeries> {
  return loadSeries(timeframe);
}

async function loadSeries(timeframe: Timeframe): Promise<CandleSeries> {
  const filePath = filePathFor(timeframe);
  const c = cache();

  const cached = c.get(filePath);
  if (cached) return cached.promise;

  if (!fs.existsSync(filePath)) {
    throw new MissingTimeframeError(timeframe, filePath);
  }

  // Store the in-flight promise synchronously, before the first await, so a second
  // caller arriving in the same tick joins this parse rather than starting another.
  const entry: CacheEntry = { promise: parseCsvFile(filePath, timeframe) };
  c.set(filePath, entry);
  try {
    const series = await entry.promise;
    entry.series = series;
    return series;
  } catch (err) {
    // A failed parse must not poison the cache forever.
    if (c.get(filePath) === entry) c.delete(filePath);
    throw err;
  }
}

function barAt(s: CandleSeries, i: number): Bar {
  return {
    time: s.time[i],
    open: s.open[i],
    high: s.high[i],
    low: s.low[i],
    close: s.close[i],
    volume: s.volume[i],
  };
}

/**
 * Largest index `i` with `series.time[i] <= time`, or -1 when every bar is
 * later than `time` (including for an empty series).
 *
 * Binary search over the ascending `time` column: M1 is 1.76M bars, and replay
 * calls this on every step, so a linear scan is not an option.
 */
export function indexAtOrBefore(series: CandleSeries, time: number): number {
  const times = series.time;
  let lo = 0;
  let hi = series.count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The first `count` bars of `series` as a zero-copy view: every column is a
 * `subarray` over the store's own buffers, so this costs seven small objects
 * regardless of the timeframe. `count` is clamped to `[0, series.count]`.
 *
 * Bar replay hands this to the indicators so that nothing computed for the
 * chart can see a candle the chart itself is hiding.
 */
export function truncateSeries(series: CandleSeries, count: number): CandleSeries {
  // NaN falls through Math.min/Math.max as NaN; treat it as "nothing visible"
  // rather than accidentally exposing the whole series.
  const n = Number.isNaN(count)
    ? 0
    : Math.min(Math.max(Math.floor(count), 0), series.count);
  return {
    timeframe: series.timeframe,
    time: series.time.subarray(0, n),
    open: series.open.subarray(0, n),
    high: series.high.subarray(0, n),
    low: series.low.subarray(0, n),
    close: series.close.subarray(0, n),
    volume: series.volume.subarray(0, n),
    spread: series.spread.subarray(0, n),
    count: n,
    skippedRows: series.skippedRows,
  };
}

/** Broker server time for error messages, in the CSV's own `YYYY-MM-DD HH:MM` shape. */
function formatServerTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * The plain `Error` (never a subclass) every `until` consumer throws when no
 * bar is at or before `until`. Routes map exactly `Error` to a 400, so the
 * class matters as much as the message, which names the earliest bar so the
 * caller can see how far off it was.
 */
function noBarAtOrBefore(series: CandleSeries, until: number): Error {
  if (series.count === 0) {
    return new Error(`No ${series.timeframe} bars are loaded, so until=${until} matches nothing.`);
  }
  const first = series.time[0];
  return new Error(
    `No ${series.timeframe} bar at or before until=${until}; ` +
      `the earliest bar is at ${first} (${formatServerTime(first)} server time).`,
  );
}

/**
 * `series` as it stood at `until`: the bars whose time is `<= until`, as a
 * zero-copy view (see `truncateSeries`). Throws a plain `Error` when no bar is
 * that old. This is the one helper replay consumers (indicators, later the
 * backtest) need, so they never reimplement the cut-off and drift apart.
 */
export function seriesAsOf(series: CandleSeries, until: number): CandleSeries {
  const idx = indexAtOrBefore(series, until);
  if (idx < 0) throw noBarAtOrBefore(series, until);
  return truncateSeries(series, idx + 1);
}

/**
 * How to pick a page. `before`, `after` and `until` are mutually exclusive;
 * with none of them the page is the most recent `limit` bars.
 * See `CandlePage` in `./types` for what each one means.
 */
export interface PageOptions {
  /** Exclusive index: the `limit` bars ending just before it (scroll-back). */
  before?: number;
  /** Exclusive index: the `limit` bars starting at `after + 1` (replay stepping). */
  after?: number;
  /** Unix seconds: the `limit` bars ending at the last bar whose time <= until. */
  until?: number;
  limit?: number;
}

const PAGE_MODES = ['before', 'after', 'until'] as const;

export async function getPage(
  timeframe: Timeframe,
  opts: PageOptions,
): Promise<CandlePage> {
  const rawLimit = opts.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
    throw new RangeError(`limit must be a positive number, received ${String(opts.limit)}`);
  }
  const limit = Math.min(Math.floor(rawLimit), MAX_PAGE_SIZE);

  // Caller mistakes are rejected before the (possibly multi-second) parse, and
  // as a plain `Error` so the route turns them into a 400 rather than a 500.
  const modes = PAGE_MODES.filter((mode) => opts[mode] !== undefined);
  if (modes.length > 1) {
    throw new Error(
      `Only one of "before", "after" and "until" may be given; received ${modes
        .map((mode) => `"${mode}"`)
        .join(' and ')}.`,
    );
  }
  // `before` keeps its historical tolerance for non-finite values (treated as
  // "the tail"); the two newer modes have no sensible reading for NaN/Infinity.
  if (opts.after !== undefined && !Number.isFinite(opts.after)) {
    throw new RangeError(`after must be a finite number, received ${String(opts.after)}`);
  }
  if (opts.until !== undefined && !Number.isFinite(opts.until)) {
    throw new RangeError(`until must be a finite number, received ${String(opts.until)}`);
  }

  const series = await loadSeries(timeframe);
  const total = series.count;

  // Half-open window [startIndex, end) into the full series.
  let startIndex: number;
  let end: number;

  if (opts.after !== undefined) {
    // `after` is exclusive. Past the end it yields the empty page at
    // `startIndex === total` rather than throwing: that IS the "end of data"
    // signal replay stops on, so it must not look like a failure.
    startIndex = Math.min(Math.max(Math.floor(opts.after) + 1, 0), total);
    end = Math.min(startIndex + limit, total);
  } else {
    if (opts.until !== undefined) {
      const idx = indexAtOrBefore(series, opts.until);
      if (idx < 0) throw noBarAtOrBefore(series, opts.until);
      end = idx + 1;
    } else {
      // `before` is exclusive. Undefined means "the tail". Out-of-range values
      // clamp rather than throw, so a client that over-scrolls just gets the
      // edge page.
      const rawBefore = opts.before;
      end =
        rawBefore === undefined || !Number.isFinite(rawBefore)
          ? total
          : Math.min(Math.max(Math.floor(rawBefore), 0), total);
    }
    startIndex = Math.max(0, end - limit);
  }

  const bars: Bar[] = new Array(end - startIndex);
  for (let i = startIndex; i < end; i++) bars[i - startIndex] = barAt(series, i);

  return {
    timeframe,
    bars,
    startIndex,
    totalBars: total,
    hasMore: startIndex > 0,
    // `startIndex + bars.length < total`, i.e. the window stops short of the last bar.
    hasNewer: end < total,
  };
}

/** Parses one `YYYY.MM.DD HH:MM,...` data line into unix seconds; null if it isn't one. */
function timeOfLine(line: string): number | null {
  const comma = line.indexOf(',');
  if (comma !== 16) return null;
  const m = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})$/.exec(line.slice(0, 16));
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) / 1000;
}

const HEAD_BYTES = 512;
const TAIL_BYTES = 512;

/**
 * Cheap metadata for an unloaded timeframe: one stat plus two small reads
 * (head for the first data line, tail for the last), never a full parse.
 *
 * `totalBars` stays null for unloaded timeframes on purpose. Rows are not fixed
 * width (prices and tick volumes vary in digit count), so size/rowLength is an
 * estimate, not a count, and an exact count would mean streaming the whole file,
 * which for M1 is the 141 MB read we are trying to avoid. Callers must treat
 * `totalBars: null` as "unknown until loaded", not as "empty".
 */
async function cheapInfo(timeframe: Timeframe): Promise<TimeframeInfo> {
  const filePath = filePathFor(timeframe);
  const absent: TimeframeInfo = {
    timeframe,
    totalBars: null,
    firstTime: null,
    lastTime: null,
    loaded: false,
  };

  let handle: fsp.FileHandle | undefined;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size === 0) return absent;
    handle = await fsp.open(filePath, 'r');

    const head = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
    await handle.read(head, 0, head.length, 0);
    const headLines = head.toString('latin1').split('\n');
    let firstTime: number | null = null;
    for (const line of headLines) {
      const t = timeOfLine(line.trim());
      if (t !== null) { firstTime = t; break; }
    }

    const tailStart = Math.max(0, stat.size - TAIL_BYTES);
    const tail = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
    await handle.read(tail, 0, tail.length, tailStart);
    const tailLines = tail.toString('latin1').split('\n');
    let lastTime: number | null = null;
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const t = timeOfLine(tailLines[i].trim());
      if (t !== null) { lastTime = t; break; }
    }

    if (firstTime === null || lastTime === null) return absent;
    return { timeframe, totalBars: null, firstTime, lastTime, loaded: false };
  } catch {
    return absent;
  } finally {
    await handle?.close();
  }
}

export async function listTimeframes(): Promise<TimeframeInfo[]> {
  const c = cache();

  return Promise.all(
    TIMEFRAMES.map(async (timeframe): Promise<TimeframeInfo> => {
      // Only report `loaded` for a timeframe whose parse has already finished;
      // reading the cache never starts one.
      const loaded = c.get(filePathFor(timeframe))?.series;
      if (loaded) {
        return {
          timeframe,
          totalBars: loaded.count,
          firstTime: loaded.count > 0 ? loaded.time[0] : null,
          lastTime: loaded.count > 0 ? loaded.time[loaded.count - 1] : null,
          loaded: true,
        };
      }
      return cheapInfo(timeframe);
    }),
  );
}
