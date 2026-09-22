'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PAGE_SIZE,
  type Bar,
  type CandlePage,
  type Timeframe,
  TIMEFRAME_MINUTES,
} from '@/lib/candles/types';
import { safeFetch } from '@/lib/http/safe-fetch';

/**
 * One immutable snapshot of everything the chart needs to draw.
 *
 * `prepended` tells the chart how many bars were spliced onto the FRONT of
 * `bars` relative to the previous snapshot. Lightweight-charts addresses bars
 * by logical index counted from the start of the array, so prepending N bars
 * shifts every existing bar by +N; the chart uses this number to shift the
 * visible logical range back and keep the viewport visually still.
 */
export interface CandleDataset {
  timeframe: Timeframe;
  bars: Bar[];
  /** Full-series index of `bars[0]`. Pass as `before` to get the next older page. */
  startIndex: number;
  totalBars: number;
  hasMore: boolean;
  /**
   * True when the series has bars after the last one held. Always false for
   * the live tail; in replay it is what `stepForward` consults before asking
   * for the next bar, and what the UI reads as "end of data" when false.
   */
  hasNewer: boolean;
  prepended: number;
  revision: number;
}

/**
 * What one `stepForward()` call did. `end` is the signal the play loop pauses
 * on; the others are silent.
 */
export type StepOutcome = 'appended' | 'end' | 'busy' | 'idle' | 'error';

/**
 * What one `stepBack()` call did. `start` means the dataset is down to its
 * one bar and nothing was removed; `busy` means a forward step is in flight
 * and the call was refused. Both are silent, like `stepForward`'s.
 */
export type StepBackOutcome = 'removed' | 'start' | 'idle' | 'busy';

/** Bars per page for the replay "as of" fetch: enough history to read the chart, not the 3000 of the live tail. */
export const REPLAY_PAGE_SIZE = 300;

export interface CandleDataResult {
  dataset: CandleDataset | null;
  /** First fetch, or a fetch triggered by a timeframe switch. */
  loading: boolean;
  /** An older page is in flight. */
  loadingOlder: boolean;
  /** A replay step (`after`) is in flight. */
  stepping: boolean;
  /** Fatal: there is no chart to show. */
  error: string | null;
  /** Non-fatal: the visible data is fine, the scroll-back page failed. */
  olderError: string | null;
  /** Non-fatal: the visible data is fine, the last replay step failed. */
  stepError: string | null;
  loadOlder: () => void;
  /**
   * Replay only: fetch the single bar after the current cutoff and append it.
   * Resolves once the bar is applied (or the call was dropped). Concurrent
   * calls are coalesced: while one step is in flight the rest resolve `busy`.
   */
  stepForward: () => Promise<StepOutcome>;
  /**
   * Replay only: drop the last bar held. No request — the bar is simply
   * removed, synchronously, so it is gone by the time this returns. Refused
   * (`busy`) while a forward step is in flight so the two can never
   * interleave, and (`start`) when only one bar is left so the view is never
   * empty. The dropped bar is newer than the new tail by construction, so the
   * result has `hasNewer: true` and the next `stepForward` re-fetches it.
   */
  stepBack: () => StepBackOutcome;
  reload: () => void;
}

interface ApiError {
  error?: string;
  code?: string;
}

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
 * The three paging modes of `/api/candles` (see `CandlePage`), mutually
 * exclusive by construction: a caller picks one field.
 */
type PageQuery =
  | { mode: 'tail' }
  | { mode: 'before'; before: number }
  | { mode: 'until'; until: number }
  | { mode: 'after'; after: number };

async function fetchPage(
  timeframe: Timeframe,
  query: PageQuery,
  limit: number,
): Promise<CandlePage> {
  const params = new URLSearchParams({
    tf: timeframe,
    limit: String(limit),
  });
  if (query.mode === 'before') params.set('before', String(query.before));
  else if (query.mode === 'until') params.set('until', String(query.until));
  else if (query.mode === 'after') params.set('after', String(query.after));

  const res = await safeFetch(`/api/candles?${params.toString()}`, {
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

  return (await res.json()) as CandlePage;
}

/**
 * Loads the newest page for `timeframe` and pages backwards on demand.
 *
 * Cancellation: every timeframe gets a generation number. Switching timeframe
 * aborts both the initial request and any in-flight older-page request and
 * bumps the generation, so a slow M1 response can never be applied after a
 * fast D1 response has landed.
 */
interface LoadResult {
  /** `timeframe:reloadToken` this result belongs to. */
  key: string;
  dataset: CandleDataset | null;
  error: string | null;
}

interface OlderStatus {
  key: string;
  loading: boolean;
  error: string | null;
}

/** Full-series index of the last bar held: what `after` is asked relative to. */
function cutoffIndexOf(dataset: CandleDataset): number {
  return dataset.startIndex + dataset.bars.length - 1;
}

/**
 * Loads the newest page for `timeframe` and pages backwards on demand.
 *
 * Cancellation: each (timeframe, reload, replayUntil) triple is a `key`.
 * Switching any of them supersedes the in-flight initial request AND any
 * in-flight older-page or step request, and every resolved response is
 * checked against the live key before it is applied — so a slow M1 response
 * can never overwrite a fast D1 one. State is also stamped with its key, so a
 * stale result is simply not read rather than being cleared by a cascade of
 * setState calls in an effect.
 *
 * Replay: with `replayUntil` set (unix seconds, server time) the initial page
 * is the ~300 bars ending at the last bar whose time <= replayUntil, and the
 * dataset then grows one bar at a time through `stepForward` and shrinks one
 * bar at a time through `stepBack`. Scroll-back is unchanged in both modes. `replayUntil` is only the ANCHOR of the page; the
 * live cutoff is the last bar held, and the caller passes that time back in as
 * the new anchor when it switches timeframe, so the cutoff survives the switch.
 */
export function useCandleData(
  timeframe: Timeframe,
  replayUntil: number | null = null,
): CandleDataResult {
  const [reloadToken, setReloadToken] = useState(0);
  const key = `${timeframe}:${reloadToken}:${replayUntil === null ? 'live' : replayUntil}`;

  const [result, setResult] = useState<LoadResult>({
    key,
    dataset: null,
    error: null,
  });
  const [olderStatus, setOlderStatus] = useState<OlderStatus>({
    key,
    loading: false,
    error: null,
  });
  const [stepStatus, setStepStatus] = useState<OlderStatus>({
    key,
    loading: false,
    error: null,
  });

  const keyRef = useRef(key);
  const datasetRef = useRef<CandleDataset | null>(null);
  const olderInFlightRef = useRef(false);
  const stepInFlightRef = useRef(false);

  useEffect(() => {
    keyRef.current = key;
    // A superseded older-page or step request is not cancelled either — same
    // reason. Its result is dropped by the `keyRef.current !== key` guard.
    olderInFlightRef.current = false;
    stepInFlightRef.current = false;
    datasetRef.current = null;

    void (async () => {
      try {
        const page =
          replayUntil === null
            ? await fetchPage(timeframe, { mode: 'tail' }, DEFAULT_PAGE_SIZE)
            : await fetchPage(
                timeframe,
                { mode: 'until', until: replayUntil },
                REPLAY_PAGE_SIZE,
              );
        if (keyRef.current !== key) return;
        const next: CandleDataset = {
          timeframe: page.timeframe,
          bars: page.bars,
          startIndex: page.startIndex,
          totalBars: page.totalBars,
          hasMore: page.hasMore && page.startIndex > 0,
          // The live tail has nothing newer by definition, whatever the server
          // says; only a replay page can.
          hasNewer: replayUntil !== null && page.hasNewer === true,
          prepended: 0,
          revision: 0,
        };
        datasetRef.current = next;
        setResult({ key, dataset: next, error: null });
      } catch (err) {
        if (isAbort(err) || keyRef.current !== key) return;
        setResult({ key, dataset: null, error: messageOf(err) });
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
  }, [key, timeframe, replayUntil]);

  const loadOlder = useCallback(() => {
    const current = datasetRef.current;
    if (current === null || !current.hasMore || olderInFlightRef.current) return;

    olderInFlightRef.current = true;
    setOlderStatus({ key, loading: true, error: null });

    void (async () => {
      try {
        const page = await fetchPage(
          current.timeframe,
          { mode: 'before', before: current.startIndex },
          DEFAULT_PAGE_SIZE,
        );
        if (keyRef.current !== key) return;
        olderInFlightRef.current = false;

        const prev = datasetRef.current;
        // Another prepend already landed for this anchor: drop the duplicate.
        if (prev === null || prev.startIndex !== current.startIndex) {
          setOlderStatus({ key, loading: false, error: null });
          return;
        }

        const next: CandleDataset = {
          timeframe: prev.timeframe,
          bars: page.bars.length > 0 ? page.bars.concat(prev.bars) : prev.bars,
          startIndex: page.bars.length > 0 ? page.startIndex : prev.startIndex,
          totalBars: page.totalBars,
          // An empty page means the server has nothing older: stop asking.
          hasMore: page.bars.length > 0 && page.hasMore && page.startIndex > 0,
          // `prev`, not `page`: a scroll-back page never knows the replay tail.
          hasNewer: prev.hasNewer,
          prepended: page.bars.length,
          revision: prev.revision + 1,
        };
        datasetRef.current = next;
        setResult({ key, dataset: next, error: null });
        setOlderStatus({ key, loading: false, error: null });
      } catch (err) {
        if (isAbort(err) || keyRef.current !== key) return;
        olderInFlightRef.current = false;
        setOlderStatus({ key, loading: false, error: messageOf(err) });
      }
    })().catch(() => {
      // Belt and braces; `safeFetch` already marks aborts observed.
    });
  }, [key]);

  const stepForward = useCallback(async (): Promise<StepOutcome> => {
    if (replayUntil === null) return 'idle';
    const current = datasetRef.current;
    if (current === null) return 'busy';
    if (!current.hasNewer) return 'end';
    if (stepInFlightRef.current) return 'busy';

    // The cutoff is a property of the LATEST dataset, read again after the
    // await: a scroll-back page landing mid-flight moves `startIndex` and
    // grows `bars` by the same amount, so the cutoff index is unchanged and
    // the append below still goes onto the right tail.
    const after = cutoffIndexOf(current);
    stepInFlightRef.current = true;
    setStepStatus({ key, loading: true, error: null });

    try {
      const page = await fetchPage(current.timeframe, { mode: 'after', after }, 1);
      if (keyRef.current !== key) return 'idle';
      stepInFlightRef.current = false;

      const prev = datasetRef.current;
      if (prev === null || cutoffIndexOf(prev) !== after) {
        // The tail moved under us (another step landed for this anchor —
        // should be impossible with the in-flight guard, but never append a
        // bar onto the wrong tail). Drop it.
        setStepStatus({ key, loading: false, error: null });
        return 'busy';
      }

      // Contract: exactly the next bar, `startIndex === after + 1`. Anything
      // else is a server that disagrees about where we are; refuse to splice.
      const bar = page.bars.length === 1 && page.startIndex === after + 1 ? page.bars[0] : null;
      const lastHeld = prev.bars.length > 0 ? prev.bars[prev.bars.length - 1] : null;
      if (bar !== null && lastHeld !== null && bar.time <= lastHeld.time) {
        throw new Error(
          `Step returned a bar at ${formatServerTime(bar.time, true)}, not after the cutoff.`,
        );
      }

      const next: CandleDataset = {
        timeframe: prev.timeframe,
        bars: bar === null ? prev.bars : prev.bars.concat([bar]),
        startIndex: prev.startIndex,
        totalBars: page.totalBars,
        hasMore: prev.hasMore,
        // An empty page means the server has nothing newer: stop asking.
        hasNewer: bar !== null && page.hasNewer === true,
        prepended: 0,
        revision: prev.revision + 1,
      };
      datasetRef.current = next;
      setResult({ key, dataset: next, error: null });
      setStepStatus({ key, loading: false, error: null });
      return bar === null ? 'end' : next.hasNewer ? 'appended' : 'end';
    } catch (err) {
      if (isAbort(err) || keyRef.current !== key) return 'idle';
      stepInFlightRef.current = false;
      setStepStatus({ key, loading: false, error: messageOf(err) });
      return 'error';
    }
  }, [key, replayUntil]);

  const stepBack = useCallback((): StepBackOutcome => {
    if (replayUntil === null) return 'idle';
    const current = datasetRef.current;
    if (current === null) return 'busy';
    // Never interleave with a forward step: its `cutoffIndexOf(prev) !== after`
    // guard would drop the fetched bar anyway, but refusing here is cheaper
    // and keeps the tail from moving under a request that is already out.
    if (stepInFlightRef.current) return 'busy';
    // The view must never become empty: the first loaded bar is the floor.
    if (current.bars.length <= 1) return 'start';

    const next: CandleDataset = {
      timeframe: current.timeframe,
      bars: current.bars.slice(0, -1),
      startIndex: current.startIndex,
      totalBars: current.totalBars,
      hasMore: current.hasMore,
      // There is now at least one newer bar: the one just removed.
      hasNewer: true,
      prepended: 0,
      revision: current.revision + 1,
    };
    datasetRef.current = next;
    setResult({ key, dataset: next, error: null });
    return 'removed';
  }, [key, replayUntil]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  const fresh = result.key === key;
  const dataset = fresh ? result.dataset : null;
  const error = fresh ? result.error : null;

  return {
    dataset,
    loading: dataset === null && error === null,
    loadingOlder: olderStatus.key === key && olderStatus.loading,
    olderError: olderStatus.key === key ? olderStatus.error : null,
    stepping: stepStatus.key === key && stepStatus.loading,
    stepError: stepStatus.key === key ? stepStatus.error : null,
    error,
    loadOlder,
    stepForward,
    stepBack,
    reload,
  };
}

/* ------------------------------------------------------------------ */
/* Formatting. MT5 timestamps are broker SERVER time with no timezone. */
/* `Bar.time` was built with Date.UTC from the raw server clock, so it */
/* must be read back with UTC getters only — a local getter would      */
/* silently shift every label by the viewer's machine offset.          */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** `2026-09-20` or `2026-09-20 14:00`, always in server (UTC-read) time. */
export function formatServerTime(unixSeconds: number, withTime: boolean): string {
  const d = new Date(unixSeconds * 1000);
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  if (!withTime) return date;
  return `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatServerMonth(unixSeconds: number): string {
  return MONTHS[new Date(unixSeconds * 1000).getUTCMonth()];
}

export function formatServerYear(unixSeconds: number): string {
  return String(new Date(unixSeconds * 1000).getUTCFullYear());
}

export function formatServerDayOfMonth(unixSeconds: number): string {
  return String(new Date(unixSeconds * 1000).getUTCDate());
}

export function formatServerClock(unixSeconds: number, withSeconds: boolean): string {
  const d = new Date(unixSeconds * 1000);
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return withSeconds ? `${hm}:${pad2(d.getUTCSeconds())}` : hm;
}

/** True when a timeframe's bars are shorter than a day, i.e. show hh:mm. */
export function isIntraday(timeframe: Timeframe): boolean {
  return TIMEFRAME_MINUTES[timeframe] < 1440;
}

/** Decimal places actually used by the data, so the axis does not over-round gold. */
export function inferPricePrecision(bars: readonly Bar[]): number {
  let precision = 2;
  const sampled = Math.min(bars.length, 300);
  for (let i = 0; i < sampled; i += 1) {
    const text = String(bars[i].close);
    const dot = text.indexOf('.');
    if (dot >= 0 && !text.includes('e')) {
      precision = Math.max(precision, Math.min(5, text.length - dot - 1));
    }
  }
  return precision;
}

export function formatPrice(value: number, precision: number): string {
  return value.toFixed(precision);
}

export function formatVolume(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return String(value);
}
