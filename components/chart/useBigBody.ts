'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Timeframe } from '@/lib/candles/types';
import type { BigBodyParams, BigBodyResult } from '@/lib/indicators/types';
import { safeFetch } from '@/lib/http/safe-fetch';

/**
 * Loads the whole shape set for the Big Body indicator in one request.
 *
 * Geometry is computed server-side over the FULL series (a level's fate
 * depends on bars after the one that created it), and big candles are sparse,
 * so there is no paging here — one fetch per (timeframe, params) pair, or per
 * (timeframe, params, cutoff) during bar replay, where the server computes
 * from bars `<= until` only.
 *
 * Cancellation mirrors `useCandleData`: each (timeframe, params) pair is a
 * `key`, the in-flight request is aborted when the key changes, and the state
 * is stamped with its key so a slow reply for the old params can never be
 * read after a fast one for the new params has landed.
 */
export interface BigBodyDataResult {
  data: BigBodyResult | null;
  loading: boolean;
  /**
   * Non-fatal. The indicator is an overlay: a failed fetch leaves the candles
   * untouched and only this message is surfaced.
   */
  error: string | null;
}

interface ApiError {
  error?: string;
  code?: string;
}

interface LoadState {
  key: string;
  /** `key` without the replay cutoff: the (timeframe, params) part. */
  base: string;
  /** The replay cutoff this result was computed for; null outside replay. */
  until: number | null;
  data: BigBodyResult | null;
  error: string | null;
}

/**
 * Floor on the interval between two `until` requests during replay. Play at
 * 10 bars/s moves the cutoff every 100 ms; the indicator recomputes over the
 * whole series per request, so it follows at most every ~300 ms and always
 * with the latest cutoff (a throttle with a trailing edge, not a debounce —
 * a debounce would never fire while bars keep arriving).
 */
const UNTIL_THROTTLE_MS = 300;

/**
 * True for a fetch aborted by an `AbortController`.
 *
 * Deliberately NOT `err instanceof DOMException`. That check fails across
 * realms, and some runtimes reject an aborted fetch with a plain `Error` named
 * `AbortError` rather than a `DOMException`. When it fails the rejection
 * escapes this hook's catch, and an unhandled rejection in Next's dev mode
 * raises the full-screen error overlay — which is modal, swallows every click
 * and clears only on reload. It looks exactly like the page hanging.
 *
 * Duck-typing the `name` is the robust check and costs nothing.
 */
function isAbort(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

/**
 * Only geometry inputs travel to the API. Colours stay on the client.
 *
 * Threshold params are sent SELECTIVELY: only the ones the active
 * `thresholdMode` actually reads. The query string is this hook's cache key
 * and the server's too, so sending an `atrPeriod` while in `pips` mode would
 * mint a distinct key for a request that computes a byte-identical result —
 * fragmenting the cache and forcing a full recompute over the whole series for
 * no behavioural difference. `pipSize` (autoPip / manualPip) is likewise a
 * `pips`-only input: the other two modes never divide by it.
 */
function queryFor(timeframe: Timeframe, params: BigBodyParams): string {
  const search = new URLSearchParams({
    tf: timeframe,
    thresholdMode: params.thresholdMode,
    frameFull: String(params.frameFull),
    showLabel: String(params.showLabel),
    levelMode: params.levelMode,
    maxDays: String(params.maxDays),
    minGap: String(params.minGap),
  });

  if (params.thresholdMode === 'pips') {
    search.set('thresholdPips', String(params.thresholdPips));
    search.set('autoPip', String(params.autoPip));
    search.set('manualPip', String(params.manualPip));
  } else if (params.thresholdMode === 'percent') {
    search.set('thresholdPercent', String(params.thresholdPercent));
  } else {
    search.set('atrPeriod', String(params.atrPeriod));
    search.set('atrMultiple', String(params.atrMultiple));
  }

  return search.toString();
}

/**
 * @param until Replay cutoff in unix seconds (server time), or null outside
 *   replay. When set, the server computes the shapes from bars `<= until`
 *   only. Null adds nothing to the query, so the cache key is byte-identical
 *   to the pre-replay one.
 */
export function useBigBody(
  timeframe: Timeframe,
  params: BigBodyParams,
  enabled: boolean,
  until: number | null = null,
): BigBodyDataResult {
  // The cutoff the query actually carries. It trails `until` by the throttle
  // during play and catches up on the trailing edge once the bars stop.
  const [appliedUntil, setAppliedUntil] = useState<number | null>(until);
  const lastAppliedAtRef = useRef(0);

  useEffect(() => {
    if (appliedUntil === until) return;
    const wait = Math.max(0, UNTIL_THROTTLE_MS - (Date.now() - lastAppliedAtRef.current));
    // Always through the timer, even at 0 ms: the state write belongs to the
    // timer callback, never to the effect body.
    const timer = setTimeout(() => {
      lastAppliedAtRef.current = Date.now();
      setAppliedUntil(until);
    }, wait);
    return () => clearTimeout(timer);
  }, [until, appliedUntil]);

  const base = useMemo(() => queryFor(timeframe, params), [timeframe, params]);
  const query = appliedUntil === null ? base : `${base}&until=${appliedUntil}`;
  const key = enabled ? query : 'disabled';

  const [state, setState] = useState<LoadState>({
    key: 'disabled',
    base: '',
    until: null,
    data: null,
    error: null,
  });
  const keyRef = useRef(key);

  useEffect(() => {
    keyRef.current = key;
    if (!enabled) return;

    void (async () => {
      try {
        const res = await safeFetch(`/api/indicators/big-body?${query}`, {
          cache: 'no-store',
        });

        if (!res.ok) {
          let message = `Request failed with status ${res.status}`;
          try {
            const body: ApiError = await res.json();
            if (typeof body.error === 'string' && body.error.length > 0) {
              message = body.code ? `${body.error} (${body.code})` : body.error;
            }
          } catch {
            /* non-JSON error body: keep the status message */
          }
          throw new Error(message);
        }

        const body = (await res.json()) as BigBodyResult;
        if (keyRef.current !== key) return;
        setState({ key, base, until: appliedUntil, data: body, error: null });
      } catch (err) {
        if (isAbort(err) || keyRef.current !== key) return;
        setState({ key, base, until: appliedUntil, data: null, error: messageOf(err) });
      }
    })().catch(() => {
      // Belt and braces; `safeFetch` already marks aborts observed.
    });

    // NOTE: this effect deliberately does NOT abort its request on cleanup.
    // Aborting produced `Uncaught (in promise) AbortError` under Next's dev
    // instrumentation, which raises the full-screen error overlay — modal,
    // swallowing every click, cleared only by a reload. Correctness never
    // depended on the abort: a stale response is already discarded by the
    // guard above, so the only cost of letting it finish is a response nobody
    // reads. That is a good trade against an app that appears to hang.
  }, [enabled, key, query, base, appliedUntil]);

  const fresh = state.key === key;
  // Replay carry-over: while the next cutoff's result is in flight, keep
  // showing the previous one IF it was computed for the same timeframe and
  // params at an EARLIER-or-equal cutoff. Such a result cannot contain a shape
  // after the current cutoff, so it is safe to leave on screen, and dropping
  // it would blink the whole overlay off and on at every step. A result for
  // another timeframe, for other params, or for the full series (entering
  // replay) is never carried: those can show the future.
  const carry =
    enabled &&
    !fresh &&
    state.error === null &&
    state.base === base &&
    state.until !== null &&
    appliedUntil !== null &&
    state.until <= appliedUntil;
  const data = enabled && (fresh || carry) ? state.data : null;
  const error = enabled && fresh ? state.error : null;

  return {
    data,
    loading: enabled && !fresh,
    error,
  };
}
