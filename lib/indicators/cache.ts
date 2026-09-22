/**
 * Memoised access to Big Body geometry.
 *
 * `computeBigBody` is pure and single-pass, but it still walks the whole
 * series — 1.76M bars on M1 — and the result is identical for identical
 * inputs, so it is cached per (timeframe, params, until) exactly the way
 * `lib/candles/store.ts` caches parsed series.
 */

import { getSeries, seriesAsOf } from '../candles/store';
import type { Timeframe } from '../candles/types';
import { computeBigBody } from './bigBody';
import type { BigBodyParams, BigBodyResult } from './types';

/**
 * Same reasoning as the candle store: Next.js dev swaps the module registry on
 * every hot reload, so a module-level Map would be dropped and every source
 * edit would re-run the indicator over the full series. A symbol-keyed
 * property on globalThis survives module re-evaluation.
 *
 * Values are Promises, stored the instant a computation starts, so concurrent
 * cold requests for the same key share one run instead of each starting their own.
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

const CACHE_KEY = Symbol.for(`indicators.bigBodyCache.v${CACHE_SCHEMA_VERSION}`);

type Cache = Map<string, Promise<BigBodyResult>>;

function cache(): Cache {
  const g = globalThis as typeof globalThis & { [CACHE_KEY]?: Cache };
  if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map<string, Promise<BigBodyResult>>();
  return g[CACHE_KEY];
}

/**
 * Canonical cache key. Built field by field in a fixed order rather than with
 * `JSON.stringify(params)`, whose output follows the insertion order of the
 * caller's object literal — two callers passing the same settings in a
 * different key order would otherwise miss each other's cache entry.
 *
 * `until` (bar replay's cut-off) is appended only when present, so the key of
 * a full-series request is byte-for-byte what it was before replay existed and
 * entries already sitting in the cache stay valid.
 */
export function bigBodyCacheKey(
  timeframe: Timeframe,
  params: BigBodyParams,
  until?: number,
): string {
  const parts = [
    timeframe,
    // Every field `computeBigBody` reads must appear here. A field that
    // changes the result but not the key makes the cache serve the previous
    // answer — which looks exactly like the new setting having no effect.
    `thresholdMode=${params.thresholdMode}`,
    `thresholdPips=${params.thresholdPips}`,
    `thresholdPercent=${params.thresholdPercent}`,
    `atrPeriod=${params.atrPeriod}`,
    `atrMultiple=${params.atrMultiple}`,
    `autoPip=${params.autoPip}`,
    `manualPip=${params.manualPip}`,
    `frameFull=${params.frameFull}`,
    `showLabel=${params.showLabel}`,
    `levelMode=${params.levelMode}`,
    `maxDays=${params.maxDays}`,
    `minGap=${params.minGap}`,
  ];
  if (until !== undefined) parts.push(`until=${until}`);
  return parts.join('|');
}

/**
 * Big Body geometry for `timeframe`, memoised per (timeframe, params, until).
 *
 * `until` (unix seconds) is bar replay's cut-off: the indicator then runs over
 * the series truncated at the last bar whose time is `<= until` — a zero-copy
 * view from the store, never a copy of 1.76M rows. Without it the levels a
 * FUTURE candle creates would be drawn on a chart that hides that candle, and
 * a replay that leaks the future is worthless. Throws a plain `Error` when no
 * bar is at or before `until` (the route turns that into a 400).
 */
export function getBigBody(
  timeframe: Timeframe,
  params: BigBodyParams,
  until?: number,
): Promise<BigBodyResult> {
  const key = bigBodyCacheKey(timeframe, params, until);
  const c = cache();

  const cached = c.get(key);
  if (cached) return cached;

  // Stored synchronously, before the first await, so a second caller in the
  // same tick joins this run. Errors (a missing timeframe, invalid params)
  // evict the entry so a failure never poisons the cache.
  const promise = (async () => {
    const full = await getSeries(timeframe);
    const series = until === undefined ? full : seriesAsOf(full, until);
    return computeBigBody(series, params);
  })().catch((err: unknown) => {
    if (c.get(key) === promise) c.delete(key);
    throw err;
  });

  c.set(key, promise);
  return promise;
}
