import {
  jsonError,
  logInternal,
  NO_STORE_HEADERS,
} from '@/lib/http/json-error';
import { listTimeframes } from '@/lib/candles/store';
import {
  SYMBOL,
  TIMEFRAMES,
  type Timeframe,
  type TimeframeInfo,
} from '@/lib/candles/types';

/** The store reads the filesystem and holds large typed arrays: Node only. */
export const runtime = 'nodejs';

/**
 * Same reasoning as `/api/candles`: the store owns caching in process memory,
 * and we do not want Next's full route cache holding its own copies of this
 * payload (which reflects which CSVs are currently loaded). Opt out and send
 * `no-store`.
 */
export const dynamic = 'force-dynamic';

/** Chart-order (M1 -> MN1) rather than whatever order the store returns. */
function inTimeframeOrder(infos: readonly TimeframeInfo[]): TimeframeInfo[] {
  const byTimeframe = new Map<Timeframe, TimeframeInfo>();
  for (const info of infos) byTimeframe.set(info.timeframe, info);
  const ordered: TimeframeInfo[] = [];
  for (const tf of TIMEFRAMES) {
    const info = byTimeframe.get(tf);
    if (info !== undefined) ordered.push(info);
  }
  return ordered;
}

export async function GET(): Promise<Response> {
  try {
    const timeframes = inTimeframeOrder(await listTimeframes());
    return Response.json(
      { symbol: SYMBOL, timeframes },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (err: unknown) {
    logInternal('[GET /api/timeframes]', err);
    return jsonError(500, 'INTERNAL', 'Internal server error.');
  }
}
