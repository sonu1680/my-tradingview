/**
 * localStorage persistence for the user's indicator layout.
 *
 * Same two rules as `lib/drawings/storage.ts`, for the same reasons:
 *
 *  1. Never throw. localStorage is absent during SSR, throws on access in some
 *     private-browsing modes, can be blocked, and quota-exceeds on write.
 *  2. Never trust what comes back. It may be from an older build or hand-edited.
 *     Each instance is validated field by field and a single bad one is dropped
 *     rather than discarding the whole layout.
 *
 * Unlike drawings, the layout is keyed by symbol ONLY, not by timeframe: an EMA
 * 200 is a view preference, and having it silently vanish when switching from
 * M15 to H1 would be a bug, not a feature.
 */

import {
  DEFAULT_LINE_WIDTH,
  INDICATOR_DEFS,
  MAX_INDICATORS,
  SOURCES,
  isIndicatorId,
  type IndicatorInstance,
} from './catalog';

/** Bump when the stored shape changes incompatibly; old entries are then ignored. */
export const STUDIO_SCHEMA_VERSION = 1;

const KEY_PREFIX = 'tv-indicators';

export function studioKey(symbol: string): string {
  return `${KEY_PREFIX}:v${STUDIO_SCHEMA_VERSION}:${symbol}`;
}

export interface StudioFile {
  version: number;
  savedAt: number;
  instances: IndicatorInstance[];
}

let hasWarned = false;

function warnOnce(message: string, error: unknown): void {
  if (hasWarned) return;
  hasWarned = true;
  console.warn(`[indicators/studioStorage] ${message}`, error);
}

function getStore(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    warnOnce('localStorage is unavailable; the indicator layout will not persist.', error);
    return null;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A CSS colour we are willing to hand to the canvas: hex, rgb() or rgba(). */
function isColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return true;
  return /^rgba?\(\s*[\d.\s,%/]+\)$/.test(trimmed);
}

export function isValidInstance(value: unknown): value is IndicatorInstance {
  if (!isObject(value)) return false;
  if (typeof value.instanceId !== 'string' || value.instanceId.length === 0) return false;
  if (typeof value.id !== 'string' || !isIndicatorId(value.id)) return false;
  if (typeof value.visible !== 'boolean') return false;
  if (typeof value.lineWidth !== 'number' || !Number.isFinite(value.lineWidth)) return false;
  if (value.lineWidth < 1 || value.lineWidth > 8) return false;
  if (typeof value.source !== 'string' || !(SOURCES as readonly string[]).includes(value.source)) {
    return false;
  }
  if (!isObject(value.params) || !isObject(value.colors)) return false;

  // Params must be finite numbers, but an unknown key is tolerated: it may be
  // an input this build removed, and `paramOf` ignores what it does not know.
  for (const entry of Object.values(value.params)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return false;
  }
  for (const entry of Object.values(value.colors)) {
    if (!isColor(entry)) return false;
  }
  return true;
}

/**
 * Fill in anything the stored instance is missing.
 *
 * An older layout may predate an input or a plot that exists now; rather than
 * rejecting it, the definition's defaults are merged underneath so the
 * indicator still draws.
 */
function hydrate(instance: IndicatorInstance): IndicatorInstance {
  const def = INDICATOR_DEFS[instance.id];
  const params: Record<string, number> = {};
  for (const input of def.inputs) params[input.key] = input.fallback;
  Object.assign(params, instance.params);

  const colors: Record<string, string> = {};
  for (const plot of def.plots) colors[plot.key] = plot.color;
  Object.assign(colors, instance.colors);

  return {
    ...instance,
    params,
    colors,
    source: def.hasSource ? instance.source : def.defaultSource,
    lineWidth: Number.isFinite(instance.lineWidth) ? instance.lineWidth : DEFAULT_LINE_WIDTH,
  };
}

export function loadStudio(symbol: string): IndicatorInstance[] {
  const store = getStore();
  if (store === null) return [];

  let raw: string | null = null;
  try {
    raw = store.getItem(studioKey(symbol));
  } catch (error) {
    warnOnce('Could not read the indicator layout.', error);
    return [];
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON: start clean rather than leaving the user with a chart that
    // refuses to load.
    return [];
  }

  if (!isObject(parsed)) return [];
  if (parsed.version !== STUDIO_SCHEMA_VERSION) return [];
  if (!Array.isArray(parsed.instances)) return [];

  const seen = new Set<string>();
  const out: IndicatorInstance[] = [];
  for (const candidate of parsed.instances) {
    if (!isValidInstance(candidate)) continue;
    // A duplicate id would make two chart series fight over the same key.
    if (seen.has(candidate.instanceId)) continue;
    seen.add(candidate.instanceId);
    out.push(hydrate(candidate));
    if (out.length >= MAX_INDICATORS) break;
  }
  return out;
}

export function saveStudio(symbol: string, instances: IndicatorInstance[]): void {
  const store = getStore();
  if (store === null) return;
  const file: StudioFile = {
    version: STUDIO_SCHEMA_VERSION,
    savedAt: Date.now(),
    instances: instances.slice(0, MAX_INDICATORS),
  };
  try {
    store.setItem(studioKey(symbol), JSON.stringify(file));
  } catch (error) {
    warnOnce('Could not save the indicator layout (quota or blocked storage).', error);
  }
}

export function clearStudio(symbol: string): void {
  const store = getStore();
  if (store === null) return;
  try {
    store.removeItem(studioKey(symbol));
  } catch (error) {
    warnOnce('Could not clear the indicator layout.', error);
  }
}
