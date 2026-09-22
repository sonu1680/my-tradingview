import {
  jsonError,
  logInternal,
  NO_STORE_HEADERS,
} from '@/lib/http/json-error';
import { MissingTimeframeError } from '@/lib/candles/store';
import { isTimeframe, SYMBOL, TIMEFRAMES } from '@/lib/candles/types';
import { getBigBody } from '@/lib/indicators/cache';
import {
  DEFAULT_BIG_BODY_PARAMS,
  isLevelMode,
  isThresholdMode,
  LEVEL_MODES,
  THRESHOLD_MODES,
  type BigBodyParams,
  type LevelMode,
  type ThresholdMode,
} from '@/lib/indicators/types';

/**
 * The indicator reads the candle store, which mmaps/parses CSVs from disk and
 * holds hundreds of MB of typed arrays, so this route must run on Node, never
 * on Edge.
 */
export const runtime = 'nodejs';

/**
 * Same reasoning as `/api/candles`: the shapes never change for a given
 * (tf, params) tuple, but the indicator cache already keeps the computed
 * result hot in process memory. Letting Next's full route cache hold a
 * serialized copy of every parameter combination would duplicate that for no
 * gain, so we opt out of the route cache entirely and send `no-store`;
 * caching stays the cache layer's job.
 */
export const dynamic = 'force-dynamic';

/**
 * Parses an optional boolean query param.
 * Only the exact strings "true" and "false" (any case) are accepted — a typo
 * must be a 400, not a silent coercion to `false`.
 * Returns `undefined` when absent, or `null` when present but invalid.
 */
function parseBoolParam(raw: string | null): boolean | undefined | null {
  if (raw === null) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return null;
}

/**
 * Parses an optional finite float query param.
 * `NaN` and `Infinity` are rejected, as are the empty string and anything
 * `Number` would coerce loosely (`Number('')` is 0).
 * Returns `undefined` when absent, or `null` when present but invalid.
 */
function parseFloatParam(
  raw: string | null,
  { min, exclusive }: { min: number; exclusive: boolean },
): number | undefined | null {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (exclusive ? value <= min : value < min) return null;
  return value;
}

/**
 * Parses an optional integer query param.
 * Non-integers are rejected rather than truncated: "1.5" for `minGap` is a
 * caller bug, and silently computing with 1 would hide it.
 * Returns `undefined` when absent, or `null` when present but invalid.
 */
function parseIntParam(
  raw: string | null,
  { min }: { min: number },
): number | undefined | null {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || !/^[+-]?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min) return null;
  return value;
}

/**
 * Parses the optional `levelMode` param. Values contain spaces and `&`
 * ("High & Low"), so they arrive percent-encoded; `URLSearchParams` has
 * already decoded them by the time we see them.
 * Returns `undefined` when absent, or `null` when present but invalid.
 */
function parseLevelMode(raw: string | null): LevelMode | undefined | null {
  if (raw === null) return undefined;
  return isLevelMode(raw) ? raw : null;
}

/**
 * Parses the optional `thresholdMode` param. Case-sensitive, like `levelMode`:
 * the three modes are a closed union and they are not interchangeable — the
 * same number means pips, a percent of price, or ATR multiples depending on
 * which one is active, so a near-miss must be a 400 rather than a silent
 * fallback to `pips`.
 * Returns `undefined` when absent, or `null` when present but invalid.
 */
function parseThresholdMode(raw: string | null): ThresholdMode | undefined | null {
  if (raw === null) return undefined;
  return isThresholdMode(raw) ? raw : null;
}

export async function GET(request: Request): Promise<Response> {
  const search = new URL(request.url).searchParams;

  const tf = search.get('tf');
  if (tf === null || !isTimeframe(tf)) {
    return jsonError(
      400,
      'INVALID_TIMEFRAME',
      `Missing or invalid "tf" query param${
        tf === null ? '' : ` (got "${tf}")`
      }. Valid values: ${TIMEFRAMES.join(', ')}.`,
    );
  }

  const thresholdMode = parseThresholdMode(search.get('thresholdMode'));
  if (thresholdMode === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      `Query param "thresholdMode" must be one of: ${THRESHOLD_MODES.join(' | ')}.`,
    );
  }

  const thresholdPercent = parseFloatParam(search.get('thresholdPercent'), {
    min: 0,
    exclusive: true,
  });
  if (thresholdPercent === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "thresholdPercent" must be a finite number > 0.',
    );
  }

  const atrPeriod = parseIntParam(search.get('atrPeriod'), { min: 1 });
  if (atrPeriod === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "atrPeriod" must be a positive integer.',
    );
  }

  const atrMultiple = parseFloatParam(search.get('atrMultiple'), {
    min: 0,
    exclusive: true,
  });
  if (atrMultiple === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "atrMultiple" must be a finite number > 0.',
    );
  }

  const thresholdPips = parseFloatParam(search.get('thresholdPips'), {
    min: 0,
    exclusive: false,
  });
  if (thresholdPips === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "thresholdPips" must be a finite number >= 0.',
    );
  }

  const autoPip = parseBoolParam(search.get('autoPip'));
  if (autoPip === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "autoPip" must be "true" or "false".',
    );
  }

  const manualPip = parseFloatParam(search.get('manualPip'), {
    min: 0,
    exclusive: true,
  });
  if (manualPip === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "manualPip" must be a finite number > 0.',
    );
  }

  const frameFull = parseBoolParam(search.get('frameFull'));
  if (frameFull === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "frameFull" must be "true" or "false".',
    );
  }

  const showLabel = parseBoolParam(search.get('showLabel'));
  if (showLabel === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "showLabel" must be "true" or "false".',
    );
  }

  const levelMode = parseLevelMode(search.get('levelMode'));
  if (levelMode === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      `Query param "levelMode" must be one of: ${LEVEL_MODES.join(' | ')}.`,
    );
  }

  const maxDays = parseIntParam(search.get('maxDays'), { min: 0 });
  if (maxDays === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "maxDays" must be a non-negative integer.',
    );
  }

  const minGap = parseIntParam(search.get('minGap'), { min: 1 });
  if (minGap === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "minGap" must be a positive integer.',
    );
  }

  /**
   * Bar replay's cut-off, unix seconds. Not a `BigBodyParams` field: it does
   * not change how the indicator reads a candle, it changes which candles
   * exist. The cache layer keys on it separately.
   */
  const until = parseIntParam(search.get('until'), { min: 0 });
  if (until === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "until" must be a non-negative integer (unix seconds).',
    );
  }

  /**
   * Built field by field, never spread: an unvalidated object spread over the
   * defaults would let an unknown query param through into the cache key.
   */
  const params: BigBodyParams = {
    thresholdMode: thresholdMode ?? DEFAULT_BIG_BODY_PARAMS.thresholdMode,
    thresholdPips: thresholdPips ?? DEFAULT_BIG_BODY_PARAMS.thresholdPips,
    thresholdPercent:
      thresholdPercent ?? DEFAULT_BIG_BODY_PARAMS.thresholdPercent,
    atrPeriod: atrPeriod ?? DEFAULT_BIG_BODY_PARAMS.atrPeriod,
    atrMultiple: atrMultiple ?? DEFAULT_BIG_BODY_PARAMS.atrMultiple,
    autoPip: autoPip ?? DEFAULT_BIG_BODY_PARAMS.autoPip,
    manualPip: manualPip ?? DEFAULT_BIG_BODY_PARAMS.manualPip,
    frameFull: frameFull ?? DEFAULT_BIG_BODY_PARAMS.frameFull,
    showLabel: showLabel ?? DEFAULT_BIG_BODY_PARAMS.showLabel,
    levelMode: levelMode ?? DEFAULT_BIG_BODY_PARAMS.levelMode,
    maxDays: maxDays ?? DEFAULT_BIG_BODY_PARAMS.maxDays,
    minGap: minGap ?? DEFAULT_BIG_BODY_PARAMS.minGap,
  };

  try {
    /**
     * Unlike `/api/candles`, this route has no paging: a level's fate depends
     * on bars after the one that created it, so the geometry is computed over
     * the whole series and the shapes are sparse enough to ship at once
     * (871 big candles on H1 at the defaults, capped to Pine's 500 most
     * recent). One request, one payload.
     *
     * With `until` (bar replay) "the whole series" is the series as of that
     * moment: bars after the cut-off do not exist for this computation, so no
     * level a hidden candle would create can reach the screen.
     */
    const result = await getBigBody(tf, params, until);
    return Response.json(result, { status: 200, headers: NO_STORE_HEADERS });
  } catch (err: unknown) {
    if (err instanceof MissingTimeframeError) {
      return jsonError(
        404,
        'TIMEFRAME_UNAVAILABLE',
        `No data loaded for timeframe "${err.timeframe}"; expected candle_data/${SYMBOL}_${err.timeframe}_5years.csv.`,
      );
    }
    /**
     * The compute layer validates the params too and signals a bad one by
     * throwing a plain `Error`. That is a caller mistake, so surface its
     * message as a 400 — only genuine failures (which arrive as Error
     * subclasses such as TypeError/RangeError, or as non-Errors) become 500s.
     */
    if (err instanceof Error && err.constructor === Error) {
      return jsonError(400, 'INVALID_PARAM', err.message);
    }
    logInternal(
      `[GET /api/indicators/big-body] tf=${tf} until=${String(until)} params=${JSON.stringify(params)}`,
      err,
    );
    return jsonError(500, 'INTERNAL', 'Internal server error.');
  }
}
