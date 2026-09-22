'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Timeframe } from '@/lib/candles/types';
import type { ManualTrade } from '@/lib/counter/manualEval';
import type { Drawing, PositionDrawing } from '@/lib/drawings/types';
import { summarise } from '@/lib/counter/summary';
import {
  clearCountLog,
  emptyCountLog,
  loadCountLog,
  saveCountLog,
} from '@/lib/counter/storage';
import type { CountSummary, CountedTrade } from '@/lib/counter/types';
import { safeFetch } from '@/lib/http/safe-fetch';

/**
 * Count mode — the opt-in running log of the positions you draw.
 *
 * WHAT IT WATCHES
 * ---------------
 * The `drawings` array. A position drawing whose id this hook has not seen
 * before, while the mode is ON, is a NEW TRADE: it is evaluated and appended.
 *
 * Turning the mode on SWEEPS UP THE CHART: every position already drawn is
 * counted too, not just the ones drawn from then on. Switching it on is how
 * you say "score my setups", and the ones already sitting there are setups.
 *
 * The one exclusion: an id already in the log is never appended twice,
 * whatever happens to the drawing afterwards. That is what stops a reload, or
 * an off/on cycle, from duplicating every row.
 *
 * THE LOG MIRRORS THE CHART. Deleting a position deletes its row, and undo
 * brings the row back exactly as it was — the row is only hidden, never
 * discarded, so no re-evaluation is needed. "Clear all" wipes both.
 *
 * REPLAY
 * ------
 * Inside replay the request carries `until = the replay cutoff`, so a trade
 * drawn "now" reads OPEN: price genuinely has not reached the stop or target
 * yet. Every time the cutoff advances, the still-open trades are re-sent and
 * resolve by themselves the moment price touches a level. Outside replay no
 * `until` is sent and a trade resolves against full history immediately, so it
 * is never `open`.
 *
 * BATCHING — the rule that keeps this cheap
 * -----------------------------------------
 * Every trigger (a new drawing, a replay step) marks the hook dirty and arms a
 * single trailing timer. Anything that happens inside that window joins the
 * same flush, and a flush sends ONE request carrying every position that needs
 * an answer: the newly drawn ones plus the still-open ones. So drawing three
 * boxes in a second is one request, and replay at 10 bars/s is ~2.5 requests a
 * second at most, not ten. A flush never overlaps another: if something goes
 * dirty mid-flight, the timer is re-armed when the response lands.
 *
 * A DECIDED TRADE IS NEVER RE-SENT. Once the server says win/loss/expired/
 * never_triggered/invalid, that row is frozen.
 */

/** At most one request per this many ms. Also the coalescing window. */
const FLUSH_DELAY_MS = 400;
/** A drag or a burst of rows must not write to localStorage on every change. */
const SAVE_DELAY_MS = 300;

export interface CountModeState {
  /** Has the log been read back off disk yet? Nothing is logged before it has. */
  loaded: boolean;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** Append order — oldest first. The table and the badge sort as they like. */
  trades: CountedTrade[];
  summary: CountSummary;
  /** A request is in flight, or one is armed. Purely for the UI's dot. */
  busy: boolean;
  /** The last evaluation failure, verbatim from the API. */
  error: string | null;
  /** Wipes the log (and its stored copy). Does not change the toggle. */
  clear: () => void;
}

export interface UseCountModeOptions {
  /** Per-symbol, like the drawings store. */
  symbol: string;
  /** All drawings; the position ones are what gets counted. */
  drawings: readonly Drawing[];
  /** Stamped onto each row: the timeframe it was drawn on. */
  timeframe: Timeframe;
  /** `replay.cutoffTime` — null outside replay. */
  cutoffTime: number | null;
  /**
   * Have the drawings been read back off disk yet?
   *
   * Required, because the log mirrors the chart: before the drawings load
   * `drawings` is empty, and pruning against it would blank the whole log and
   * then persist that. Nothing is pruned or saved until this is true.
   */
  drawingsLoaded: boolean;
  /** Charge the M1 spread. */
  includeSpread?: boolean;
}

interface ManualEvalResponse {
  trades: ManualTrade[];
}

/** The API's error envelope; see lib/http/json-error.ts. */
interface ApiErrorBody {
  error?: string;
  code?: string;
}

async function errorFor(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (typeof body.error === 'string' && body.error.length > 0) {
      return body.code ? `${body.error} (${body.code})` : body.error;
    }
  } catch {
    /* non-JSON error body: fall through to the status */
  }
  return `Request failed with status ${res.status}`;
}

function isAbort(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/** A server verdict, dressed as a log row. `loggedAt`/`timeframe` are ours. */
function toCounted(
  trade: ManualTrade,
  loggedAt: number,
  timeframe: Timeframe,
): CountedTrade {
  return {
    id: trade.id,
    loggedAt,
    timeframe,
    side: trade.side,
    entry: trade.entry,
    stop: trade.stop,
    target: trade.target,
    riskPips: trade.riskPips,
    rewardPips: trade.rewardPips,
    plannedRR: trade.plannedRR,
    outcome: trade.outcome,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    exitPrice: trade.exitPrice,
    pips: trade.pips,
    r: trade.r,
    minutesHeld: trade.minutesHeld,
    reason: trade.reason,
  };
}

export function useCountMode({
  symbol,
  drawings,
  timeframe,
  cutoffTime,
  drawingsLoaded,
  includeSpread = true,
}: UseCountModeOptions): CountModeState {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [trades, setTrades] = useState<CountedTrade[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const positions = useMemo(
    () =>
      drawings.filter(
        (drawing): drawing is PositionDrawing => drawing.kind === 'position',
      ),
    [drawings],
  );

  /**
   * The log mirrors the chart: a row whose drawing has been deleted is gone.
   *
   * Derived rather than spliced out of state, for two reasons. It needs no
   * `setState` inside an effect (which the React Compiler lint rules reject),
   * and it makes UNDO free: the deleted row is still in `trades`, so restoring
   * the drawing brings its original row straight back — same stamp, same
   * verdict, no re-evaluation.
   *
   * Until the drawings have loaded, every row is shown. Filtering against an
   * empty `positions` would blank the log for a frame and, worse, persist it.
   */
  const liveIds = useMemo(
    () => new Set(positions.map((position) => position.id)),
    [positions],
  );
  const visibleTrades = useMemo(
    () => (drawingsLoaded ? trades.filter((trade) => liveIds.has(trade.id)) : trades),
    [trades, liveIds, drawingsLoaded],
  );

  /* ---------- refs: everything the flush reads, none read during render ---------- */

  // Ids the mode has already decided about. `null` means "not counting", which
  // is also how the hook knows the next enabled pass is the seeding one.
  const seenRef = useRef<Set<string> | null>(null);
  // The position payload for every id we may still need to re-evaluate, and the
  // source of each row's `createdAt` stamp. It outlives the drawing by a beat,
  // which is what lets an undo restore a row without a round trip.
  const payloadRef = useRef(new Map<string, PositionDrawing>());
  // Ids queued for their first evaluation.
  const queueRef = useRef(new Set<string>());

  const tradesRef = useRef<CountedTrade[]>([]);
  const timeframeRef = useRef(timeframe);
  const cutoffRef = useRef(cutoffTime);
  const spreadRef = useRef(includeSpread);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `flush` re-arms itself when something went dirty mid-flight. It reaches
  // itself through this ref rather than by closing over its own binding, which
  // keeps the callback free of a self-reference the React Compiler cannot
  // memoize through.
  const flushRef = useRef<() => void>(() => {});
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const dirtyRef = useRef(false);
  // Monotonic: only the newest response is allowed to write state.
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    // The flush reads this to decide what is already known and which rows are
    // still open. A row whose drawing is gone must not be re-evaluated.
    tradesRef.current = visibleTrades;
  }, [visibleTrades]);

  /* ---------- load / persist ---------- */

  // localStorage is client-only, so the read is deferred off the first render
  // rather than done in an initialiser that would also run during SSR.
  const loadedOnceRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled || loadedOnceRef.current) return;
      loadedOnceRef.current = true;
      const file = loadCountLog(symbol);
      setTrades(file.trades);
      setEnabledState(file.enabled);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  useEffect(() => {
    // `drawingsLoaded` guards the prune: saving before it is true would write
    // an empty log over a full one.
    if (!loaded || !drawingsLoaded) return;
    const timer = setTimeout(() => {
      saveCountLog(symbol, { ...emptyCountLog(symbol), enabled, trades: visibleTrades });
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [symbol, enabled, visibleTrades, loaded, drawingsLoaded]);

  /* ---------- teardown ---------- */

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  /* ---------- the flush ---------- */

  const flush = useCallback(() => {
    if (!mountedRef.current) return;
    if (inFlightRef.current) {
      // Something asked while a request was in flight: answered on its return.
      dirtyRef.current = true;
      return;
    }

    // ONE request for everything that needs an answer: the newly drawn
    // positions, plus every trade still open as of the previous cutoff.
    const ids = new Set(queueRef.current);
    for (const trade of tradesRef.current) {
      if (trade.outcome === 'open') ids.add(trade.id);
    }

    const batch: PositionDrawing[] = [];
    for (const id of ids) {
      const position = payloadRef.current.get(id);
      // An open trade whose drawing was deleted BEFORE this session (so the
      // payload was never captured) cannot be re-evaluated. It stays open and
      // the UI says so, rather than being silently scored.
      if (position !== undefined) batch.push(position);
    }

    queueRef.current.clear();
    dirtyRef.current = false;

    if (batch.length === 0) {
      setBusy(false);
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    inFlightRef.current = true;
    requestSeqRef.current += 1;
    const seq = requestSeqRef.current;

    const until = cutoffRef.current;
    const stampedTimeframe = timeframeRef.current;

    /**
     * When the trade was TAKEN, not when it was scored.
     *
     * The drawing carries `createdAt` (unix ms) from the moment it was placed,
     * so a position drawn before Count mode was switched on is stamped with
     * when you actually drew it rather than with the moment the sweep picked
     * it up. `Date.now()` is only the fallback for a payload that somehow is
     * not on hand — and then it is at least truthful about being now.
     */
    const drawnAt = (id: string): number => {
      const createdAt = payloadRef.current.get(id)?.createdAt;
      const ms = typeof createdAt === 'number' && Number.isFinite(createdAt)
        ? createdAt
        : Date.now();
      return Math.floor(ms / 1000);
    };

    setBusy(true);

    void (async () => {
      try {
        const res = await safeFetch('/api/manual-eval', {
          method: 'POST',
          signal: controller.signal,
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            positions: batch,
            includeSpread: spreadRef.current,
            // Outside replay nothing is sent, so the trade resolves against
            // full history and can never come back `open`.
            ...(until !== null ? { until } : {}),
          }),
        });
        if (!res.ok) throw new Error(await errorFor(res));
        const body = (await res.json()) as ManualEvalResponse;
        if (controller.signal.aborted || !mountedRef.current) return;
        // A slower earlier response must never overwrite a newer verdict.
        if (seq < appliedSeqRef.current) return;
        appliedSeqRef.current = seq;

        const verdicts = new Map(
          (body.trades ?? []).map((trade) => [trade.id, trade] as const),
        );

        setTrades((previous) => {
          const next = previous.map((row) =>
            // A decided row is frozen; only the open ones move.
            row.outcome === 'open' && verdicts.has(row.id)
              ? // `loggedAt` and `timeframe` are when YOU drew it, not when the
                // server got round to deciding: they are carried over.
                toCounted(verdicts.get(row.id)!, row.loggedAt, row.timeframe)
              : row,
          );
          const known = new Set(next.map((row) => row.id));
          for (const trade of body.trades ?? []) {
            if (known.has(trade.id)) continue;
            next.push(toCounted(trade, drawnAt(trade.id), stampedTimeframe));
          }
          return next;
        });
        setError(null);
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return;
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : 'Evaluation failed');
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        inFlightRef.current = false;
        if (!mountedRef.current) return;
        setBusy(false);
        // Anything that arrived mid-flight gets its own window.
        if (dirtyRef.current) {
          dirtyRef.current = false;
          if (timerRef.current === null) {
            timerRef.current = setTimeout(() => {
              timerRef.current = null;
              flushRef.current();
            }, FLUSH_DELAY_MS);
            setBusy(true);
          }
        }
      }
    })().catch(() => {
      // Belt and braces; `safeFetch` already marks aborts observed.
    });
  }, []);

  /**
   * Arms the single trailing timer. Calling it ten times inside the window
   * still produces exactly one flush — that is the whole debounce.
   */
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) return;
    setBusy(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, FLUSH_DELAY_MS);
  }, [flush]);

  /* ---------- the watcher ---------- */

  useEffect(() => {
    timeframeRef.current = timeframe;
    spreadRef.current = includeSpread;
    cutoffRef.current = cutoffTime;

    if (!loaded) return;

    if (!enabled) {
      // Off: forget the session's bookkeeping, keep the rows. Anything drawn
      // while off is picked up by the sweep when it is switched back on; the
      // log itself is what stops an already-counted trade being re-added.
      seenRef.current = null;
      queueRef.current.clear();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      controllerRef.current?.abort();
      controllerRef.current = null;
      return;
    }

    // Keep the payloads current: an edited box is re-sent with its new levels
    // while it is still open.
    for (const position of positions) payloadRef.current.set(position.id, position);

    if (seenRef.current === null) {
      // The mode has just been switched on (or restored by a reload). Seed
      // ONLY from the log, so everything already on the chart falls through to
      // the sweep below and gets counted, while anything already logged does
      // not come back as a duplicate row.
      seenRef.current = new Set(tradesRef.current.map((trade) => trade.id));
    }

    // One path for both the initial sweep and every later drawing: an id that
    // has not been decided about is queued exactly once.
    for (const position of positions) {
      if (seenRef.current.has(position.id)) continue;
      seenRef.current.add(position.id);
      queueRef.current.add(position.id);
    }

    const hasOpen = tradesRef.current.some((trade) => trade.outcome === 'open');
    if (queueRef.current.size > 0 || hasOpen) schedule();
  }, [loaded, enabled, positions, timeframe, cutoffTime, includeSpread, schedule]);

  /* ---------- controls ---------- */

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    if (!next) setError(null);
  }, []);

  const clear = useCallback(() => {
    setTrades([]);
    tradesRef.current = [];
    setError(null);
    clearCountLog(symbol);
  }, [symbol]);

  const summary = useMemo(() => summarise(visibleTrades), [visibleTrades]);

  return {
    loaded,
    enabled,
    setEnabled,
    trades: visibleTrades,
    summary,
    busy,
    error,
    clear,
  };
}
