import { jsonError, logInternal, NO_STORE_HEADERS } from '@/lib/http/json-error';
import { getSeries, MissingTimeframeError } from '@/lib/candles/store';
import { SYMBOL } from '@/lib/candles/types';
import { DEFAULT_STYLE, type PositionDrawing } from '@/lib/drawings/types';
import { evaluateManualPositions } from '@/lib/counter/manualEval';

/**
 * Manual mode evaluates hand-drawn positions against the 1.76M-bar M1 series,
 * which the candle store parses from disk into hundreds of MB of typed arrays.
 * Node only, never Edge — same as `/api/backtest`.
 */
export const runtime = 'nodejs';

/**
 * Same reasoning as the sibling routes: the answer is a pure function of the
 * posted positions, but the positions live in the caller's `localStorage` and
 * differ per browser, so a route cache would only ever hold single-use entries.
 * We opt out entirely and send `no-store`.
 */
/**
 * Spread is charged by default: a manual review that ignores it flatters
 * every setup drawn, which is the opposite of what this endpoint is for.
 */
const DEFAULT_INCLUDE_SPREAD = true;

export const dynamic = 'force-dynamic';

/**
 * Hard cap on positions per request.
 *
 * A drawn chart holds tens of boxes, not hundreds, so 500 is far above any
 * honest use while keeping the worst case bounded: each position costs one
 * binary search plus a walk over the minutes inside its own window, and an
 * unbounded array from an untrusted client is a free way to pin a CPU.
 */
const MAX_POSITIONS = 500;

/** Every price/time field that must be a finite number. */
const NUMERIC_FIELDS = ['time', 'endTime', 'entry', 'stop', 'target'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates one posted entry and rebuilds it as a `PositionDrawing`.
 *
 * Returns the field name that is wrong, as a string, or the drawing when it is
 * sound. The distinction this function draws is the sharp one:
 *
 *   STRUCTURALLY MALFORMED (wrong type, missing field, bad `side`) is the
 *   CLIENT'S BUG and becomes a 400 naming the index and the field.
 *
 *   GEOMETRICALLY BAD (stop above entry on a long, `endTime <= time`) is a
 *   LEGITIMATE RESULT: it passes through here and comes back from the engine as
 *   `outcome: 'invalid'` with a reason. Rejecting it would throw away the
 *   answer the user drew the box to get.
 *
 * The result is rebuilt field by field rather than spread, so nothing the
 * client invented can ride along into the engine.
 */
function parsePosition(raw: unknown): PositionDrawing | string {
  if (!isRecord(raw)) return 'must be an object';
  if (raw.kind !== 'position') return 'kind must be "position"';
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    return 'id must be a non-empty string';
  }
  if (raw.side !== 'long' && raw.side !== 'short') {
    return 'side must be "long" or "short"';
  }
  for (const field of NUMERIC_FIELDS) {
    if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field])) {
      return `${field} must be a finite number`;
    }
  }

  return {
    id: raw.id,
    kind: 'position',
    side: raw.side,
    time: raw.time as number,
    endTime: raw.endTime as number,
    entry: raw.entry as number,
    stop: raw.stop as number,
    target: raw.target as number,
    /**
     * `lots` drives dollar P&L, which manual mode deliberately does not report,
     * so it is ignored rather than required — demanding a field we never read
     * would be a needless way to reject a valid request.
     */
    lots: 0,
    // Presentation only; the engine never reads either, so we do not make the
    // client send them.
    style: DEFAULT_STYLE,
    createdAt: 0,
  };
}

export async function POST(request: Request): Promise<Response> {
  /* ---------- Body ---------- */

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'INVALID_PARAM', 'Request body must be valid JSON.');
  }

  if (!isRecord(body)) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Request body must be a JSON object of the form { positions: PositionDrawing[], includeSpread?: boolean, until?: number }.',
    );
  }

  const { positions: rawPositions, includeSpread: rawIncludeSpread, until: rawUntil } = body;

  if (!Array.isArray(rawPositions)) {
    return jsonError(400, 'INVALID_PARAM', 'Body field "positions" must be an array.');
  }
  if (rawPositions.length > MAX_POSITIONS) {
    return jsonError(
      400,
      'INVALID_PARAM',
      `Body field "positions" holds ${rawPositions.length} entries; at most ${MAX_POSITIONS} may be evaluated per request. Split the request.`,
    );
  }

  if (rawIncludeSpread !== undefined && typeof rawIncludeSpread !== 'boolean') {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Body field "includeSpread" must be a boolean when present.',
    );
  }
  const includeSpread = rawIncludeSpread ?? DEFAULT_INCLUDE_SPREAD;

  /**
   * The bar-replay cutoff, in unix seconds. Absent means "evaluate against the
   * whole series", which is the answer the tester has always given; present, it
   * caps how far the engine may read so a position drawn on the replay's
   * leading edge reads `open` instead of revealing its outcome.
   *
   * A unix second is a non-negative integer. Anything else — a float, a
   * negative, a string, NaN — is the client's bug and is named, not coerced.
   */
  if (
    rawUntil !== undefined &&
    (typeof rawUntil !== 'number' ||
      !Number.isInteger(rawUntil) ||
      rawUntil < 0)
  ) {
    return jsonError(
      400,
      'INVALID_PARAM',
      'Body field "until" must be a non-negative integer number of unix seconds when present.',
    );
  }
  const until = rawUntil as number | undefined;

  const positions: PositionDrawing[] = [];
  for (let i = 0; i < rawPositions.length; i++) {
    const parsed = parsePosition(rawPositions[i]);
    if (typeof parsed === 'string') {
      return jsonError(400, 'INVALID_PARAM', `positions[${i}]: ${parsed}.`);
    }
    positions.push(parsed);
  }

  /* ---------- Evaluate ---------- */

  try {
    /**
     * Manual positions are evaluated directly on the minute series: a hand-drawn
     * box has an absolute time and price, so M1 is both the simplest and the
     * most accurate answer the data supports.
     */
    const m1 = await getSeries('M1');
    const result = evaluateManualPositions(m1, positions, { includeSpread, until });

    return Response.json(
      { ...result, includeSpread, until },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (err: unknown) {
    if (err instanceof MissingTimeframeError) {
      return jsonError(
        404,
        'TIMEFRAME_UNAVAILABLE',
        `No minute data loaded, so hand-drawn positions cannot be evaluated; expected candle_data/${SYMBOL}_M1_5years.csv.`,
      );
    }
    logInternal(`[POST /api/manual-eval] positions=${positions.length}`, err);
    return jsonError(500, 'INTERNAL', 'Internal server error.');
  }
}
