import {
  jsonError,
  logInternal,
  NO_STORE_HEADERS,
} from '@/lib/http/json-error';
import { getPage, MissingTimeframeError } from '@/lib/candles/store';
import {
  DEFAULT_PAGE_SIZE,
  isTimeframe,
  SYMBOL,
  TIMEFRAMES,
} from '@/lib/candles/types';

/**
 * The store mmaps/parses CSVs from disk and holds hundreds of MB of typed
 * arrays, so this route must run on Node, never on Edge.
 */
export const runtime = 'nodejs';

/**
 * The bars themselves never change, but a single page can be several MB of
 * JSON and the store already keeps the parsed series hot in process memory.
 * Letting Next's full route cache hold serialized copies of every
 * (tf, before/after/until, limit) combination would duplicate that data on the
 * server for no gain, so we opt out of the route cache entirely and send
 * `no-store`; caching stays the store's job.
 */
export const dynamic = 'force-dynamic';

/** CSV naming convention in `candle_data/`, used for the 404 message. */
function expectedFilename(timeframe: string): string {
  return `${SYMBOL}_${timeframe}_5years.csv`;
}

/**
 * Parses an optional non-negative / positive integer query param.
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

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const tf = params.get('tf');
  if (tf === null || !isTimeframe(tf)) {
    return jsonError(
      400,
      'INVALID_TIMEFRAME',
      `Missing or invalid "tf" query param${
        tf === null ? '' : ` (got "${tf}")`
      }. Valid values: ${TIMEFRAMES.join(', ')}.`,
    );
  }

  const before = parseIntParam(params.get('before'), { min: 0 });
  if (before === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "before" must be a non-negative integer.',
    );
  }

  const after = parseIntParam(params.get('after'), { min: 0 });
  if (after === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "after" must be a non-negative integer.',
    );
  }

  const until = parseIntParam(params.get('until'), { min: 0 });
  if (until === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "until" must be a non-negative integer (unix seconds).',
    );
  }

  /**
   * The three paging modes pick different windows of the same series, so a
   * request naming two of them has no single right answer. Rejected here,
   * before the store is asked to parse anything, and named so the caller can
   * see which two collided.
   */
  const modes = (
    [
      ['before', before],
      ['after', after],
      ['until', until],
    ] as const
  )
    .filter(([, value]) => value !== undefined)
    .map(([name]) => `"${name}"`);
  if (modes.length > 1) {
    return jsonError(
      400,
      'INVALID_PARAM',
      `Query params ${modes.join(' and ')} are mutually exclusive; pass at most one of "before", "after", "until".`,
    );
  }

  const limit = parseIntParam(params.get('limit'), { min: 1 });
  if (limit === null) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Query param "limit" must be a positive integer.',
    );
  }

  try {
    const page = await getPage(tf, {
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      ...(until === undefined ? {} : { until }),
      limit: limit ?? DEFAULT_PAGE_SIZE,
    });
    return Response.json(page, { status: 200, headers: NO_STORE_HEADERS });
  } catch (err: unknown) {
    if (err instanceof MissingTimeframeError) {
      return jsonError(
        404,
        'TIMEFRAME_UNAVAILABLE',
        `No data loaded for timeframe "${err.timeframe}"; expected candle_data/${expectedFilename(
          err.timeframe,
        )}.`,
      );
    }
    /**
     * The store signals a caller mistake it alone can detect — an `until`
     * older than the first bar — by throwing a plain `Error`. Surface its
     * message as a 400; only genuine failures (Error subclasses such as
     * RangeError, or non-Errors) become 500s.
     */
    if (err instanceof Error && err.constructor === Error) {
      return jsonError(400, 'INVALID_PARAM', err.message);
    }
    logInternal(
      `[GET /api/candles] tf=${tf} before=${String(before)} after=${String(after)} until=${String(until)} limit=${String(limit)}`,
      err,
    );
    return jsonError(500, 'INTERNAL', 'Internal server error.');
  }
}
