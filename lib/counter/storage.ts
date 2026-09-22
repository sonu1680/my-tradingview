/**
 * localStorage persistence for the Count-mode log, one entry per symbol.
 *
 * Mirrors `lib/drawings/storage.ts` exactly, for the same two reasons:
 *
 *  1. Never throw. localStorage is absent on the server, throws on access in
 *     some private-browsing modes, can be blocked outright, and quota-exceeds
 *     on write. A failure degrades to "no log", never to a crash.
 *  2. Never trust what comes back. The blob may be from an older build, hand
 *     edited in devtools, or truncated. It is validated field by field, and a
 *     single bad trade is dropped rather than discarding the whole log.
 *
 * One thing this store keeps that the drawings store does not: the ON/OFF flag
 * itself. Count mode is a session the user is in the middle of, so a reload
 * must put them back in it rather than silently stop counting.
 */

import {
  COUNT_LOG_VERSION,
  MAX_COUNTED_TRADES,
  type CountLogFile,
  type CountedTrade,
} from './types';

const KEY_PREFIX = 'tv-count-log';

/** Storage key for a symbol. Includes the version so a bump orphans old data. */
export function storageKey(symbol: string): string {
  return `${KEY_PREFIX}:v${COUNT_LOG_VERSION}:${symbol}`;
}

/* ---------- guarded access ---------- */

let hasWarned = false;

function warnOnce(message: string, error: unknown): void {
  if (hasWarned) return;
  hasWarned = true;
  console.warn(`[counter/storage] ${message}`, error);
}

function getStore(): Storage | null {
  // Safe to import from a server component: no window, no storage, no crash.
  if (typeof window === 'undefined') return null;
  try {
    const store = globalThis.localStorage;
    return store ?? null;
  } catch (error) {
    warnOnce('localStorage is unavailable; the count log will not persist.', error);
    return null;
  }
}

/* ---------- validation ---------- */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Optional numeric field: absent is fine, present-and-not-a-number is not. */
const isOptNum = (v: unknown): boolean => v === undefined || isNum(v);

const OUTCOMES = new Set([
  'open',
  'win',
  'loss',
  'expired',
  'never_triggered',
  'invalid',
]);

/** Type guard for anything read back out of storage. */
export function isValidCountedTrade(value: unknown): value is CountedTrade {
  if (!isObject(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (!isNum(value.loggedAt)) return false;
  if (typeof value.timeframe !== 'string' || value.timeframe.length === 0) return false;
  if (value.side !== 'long' && value.side !== 'short') return false;
  if (!isNum(value.entry) || !isNum(value.stop) || !isNum(value.target)) return false;
  if (!isNum(value.riskPips) || !isNum(value.rewardPips)) return false;
  // Null is meaningful here — the stop sits on the entry — so it is not optional.
  if (value.plannedRR !== null && !isNum(value.plannedRR)) return false;
  if (typeof value.outcome !== 'string' || !OUTCOMES.has(value.outcome)) return false;

  if (!isOptNum(value.entryTime)) return false;
  if (!isOptNum(value.exitTime)) return false;
  if (!isOptNum(value.exitPrice)) return false;
  if (!isOptNum(value.pips)) return false;
  if (!isOptNum(value.r)) return false;
  if (!isOptNum(value.minutesHeld)) return false;
  if (value.reason !== undefined && typeof value.reason !== 'string') return false;

  return true;
}

/**
 * The newest `MAX_COUNTED_TRADES`. The log is append-ordered, so the oldest
 * entries are the ones dropped — a long session degrades into a recent window
 * rather than failing to save at all.
 */
function cap(trades: readonly CountedTrade[]): CountedTrade[] {
  return trades.length <= MAX_COUNTED_TRADES
    ? [...trades]
    : trades.slice(trades.length - MAX_COUNTED_TRADES);
}

/* ---------- api ---------- */

/** An empty, disabled log. Count mode is opt-in, so this is the default state. */
export function emptyCountLog(symbol: string): CountLogFile {
  return { version: COUNT_LOG_VERSION, symbol, enabled: false, trades: [] };
}

/**
 * Reads the log. Any failure — no storage, corrupt JSON, wrong version — comes
 * back as an empty, disabled log rather than an exception.
 */
export function loadCountLog(symbol: string): CountLogFile {
  const store = getStore();
  if (!store) return emptyCountLog(symbol);

  let raw: string | null;
  try {
    raw = store.getItem(storageKey(symbol));
  } catch (error) {
    warnOnce('Failed to read the count log from localStorage.', error);
    return emptyCountLog(symbol);
  }
  if (raw === null) return emptyCountLog(symbol);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt or truncated JSON: start clean rather than crash.
    return emptyCountLog(symbol);
  }

  if (!isObject(parsed)) return emptyCountLog(symbol);
  if (parsed.version !== COUNT_LOG_VERSION) return emptyCountLog(symbol);
  if (!Array.isArray(parsed.trades)) return emptyCountLog(symbol);

  return {
    version: COUNT_LOG_VERSION,
    symbol,
    enabled: parsed.enabled === true,
    // Drop the individual bad entries, keep everything that still parses.
    trades: cap(parsed.trades.filter(isValidCountedTrade)),
  };
}

export function saveCountLog(symbol: string, file: CountLogFile): void {
  const store = getStore();
  if (!store) return;

  const payload: CountLogFile = {
    version: COUNT_LOG_VERSION,
    symbol,
    enabled: file.enabled,
    trades: cap(file.trades),
  };

  try {
    store.setItem(storageKey(symbol), JSON.stringify(payload));
  } catch (error) {
    // Quota exceeded, blocked, or serialisation failure: silently give up.
    warnOnce('Failed to save the count log to localStorage.', error);
  }
}

export function clearCountLog(symbol: string): void {
  const store = getStore();
  if (!store) return;
  try {
    store.removeItem(storageKey(symbol));
  } catch (error) {
    warnOnce('Failed to clear the count log from localStorage.', error);
  }
}
