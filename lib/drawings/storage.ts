/**
 * localStorage persistence for chart drawings, one entry per symbol.
 *
 * Two rules drive everything here:
 *
 *  1. Never throw. localStorage is absent on the server, throws on access in
 *     some private-browsing modes, can be blocked outright by the user, and
 *     quota-exceeds on write. A charting UI must not die because of that, so
 *     every access is wrapped and failures degrade to "no saved drawings".
 *  2. Never trust what comes back. The stored blob may be from an older
 *     build, hand-edited in devtools, or truncated. It is validated field by
 *     field, and a single bad drawing is dropped rather than discarding the
 *     whole set.
 */

import {
  DRAWINGS_SCHEMA_VERSION,
  type Anchor,
  type Drawing,
  type DrawingStyle,
  type DrawingsFile,
} from './types';

const KEY_PREFIX = 'tv-drawings';

/** Storage key for a symbol. Includes the schema version so a bump orphans old data. */
export function storageKey(symbol: string): string {
  return `${KEY_PREFIX}:v${DRAWINGS_SCHEMA_VERSION}:${symbol}`;
}

/* ---------- guarded access ---------- */

let hasWarned = false;

function warnOnce(message: string, error: unknown): void {
  if (hasWarned) return;
  hasWarned = true;
  console.warn(`[drawings/storage] ${message}`, error);
}

/**
 * The Storage object, or null when there isn't one we can use: server
 * rendering, a blocked/absent implementation, or a throwing accessor.
 */
function getStore(): Storage | null {
  // Safe to import from a server component: no window, no storage, no crash.
  if (typeof window === 'undefined') return null;
  try {
    const store = globalThis.localStorage;
    return store ?? null;
  } catch (error) {
    warnOnce('localStorage is unavailable; drawings will not persist.', error);
    return null;
  }
}

/* ---------- validation ---------- */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isAnchor = (v: unknown): v is Anchor =>
  isObject(v) && isNum(v.time) && isNum(v.price);

const isStyle = (v: unknown): v is DrawingStyle =>
  isObject(v) && typeof v.color === 'string' && isNum(v.width);

/** Type guard for anything read back out of storage. */
export function isValidDrawing(value: unknown): value is Drawing {
  if (!isObject(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (!isNum(value.createdAt)) return false;
  if (!isStyle(value.style)) return false;

  switch (value.kind) {
    case 'trendline':
    case 'rect':
    case 'fib':
      return isAnchor(value.a) && isAnchor(value.b);
    case 'hline':
      return isNum(value.price);
    case 'vline':
      // Must be listed here: the default branch drops unknown kinds, which
      // would silently erase every saved vertical line on the next load.
      return isNum(value.time);
    case 'position':
      return (
        (value.side === 'long' || value.side === 'short') &&
        isNum(value.time) &&
        isNum(value.endTime) &&
        isNum(value.entry) &&
        isNum(value.stop) &&
        isNum(value.target) &&
        isNum(value.lots)
      );
    default:
      // Unknown kind: an older or newer build, or junk.
      return false;
  }
}

/* ---------- api ---------- */

export function loadDrawings(symbol: string): Drawing[] {
  const store = getStore();
  if (!store) return [];

  let raw: string | null;
  try {
    raw = store.getItem(storageKey(symbol));
  } catch (error) {
    warnOnce('Failed to read drawings from localStorage.', error);
    return [];
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt or truncated JSON: start clean rather than crash.
    return [];
  }

  if (!isObject(parsed)) return [];
  if (parsed.version !== DRAWINGS_SCHEMA_VERSION) return [];
  if (!Array.isArray(parsed.drawings)) return [];

  // Drop the individual bad entries, keep everything that still parses.
  return parsed.drawings.filter(isValidDrawing);
}

export function saveDrawings(symbol: string, drawings: Drawing[]): void {
  const store = getStore();
  if (!store) return;

  const file: DrawingsFile = {
    version: DRAWINGS_SCHEMA_VERSION,
    symbol,
    drawings,
  };

  try {
    store.setItem(storageKey(symbol), JSON.stringify(file));
  } catch (error) {
    // Quota exceeded, blocked, or serialisation failure: silently give up.
    warnOnce('Failed to save drawings to localStorage.', error);
  }
}

export function clearDrawings(symbol: string): void {
  const store = getStore();
  if (!store) return;
  try {
    store.removeItem(storageKey(symbol));
  } catch (error) {
    warnOnce('Failed to clear drawings from localStorage.', error);
  }
}
