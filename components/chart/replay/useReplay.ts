'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CandleDataResult } from '../useCandleData';

/**
 * Bar replay: the state machine over `useCandleData`'s replay mode.
 *
 *   idle ──start(t)──▶ active(paused) ◀──play/pause──▶ active(playing)
 *     ▲                     │                               │
 *     └───────exit()────────┴───────────────────────────────┘
 *
 * The page owns the one piece of state that decides idle vs active: the
 * `until` anchor it feeds to `useCandleData(timeframe, until)`. This hook owns
 * everything on top — play/pause, speed, the interval, the keyboard — and
 * derives the readout (cutoff time / index, end of data) from the dataset the
 * candle hook holds, so there is exactly one source of truth for "where are
 * we": the last bar in the dataset.
 *
 * `playing` is real state, not derived, and it is only ever cleared by an
 * event: the user pausing or exiting, or a step reporting `end`. That keeps
 * the interval effect a pure function of (active, playing, speed) and leaves
 * no setState in any effect body.
 */

export type ReplaySpeed = 1 | 2 | 5 | 10;
export const REPLAY_SPEEDS: readonly ReplaySpeed[] = [1, 2, 5, 10];
export const DEFAULT_REPLAY_SPEED: ReplaySpeed = 2;

export interface ReplayControls {
  /** `until !== null`: the chart is showing history "as of" a cutoff. */
  active: boolean;
  /** The interval is running (always false when idle). */
  playing: boolean;
  /** Bars per second while playing. */
  speed: ReplaySpeed;
  /**
   * The replay clock, unix seconds server time: the time of the last bar
   * held. Falls back to the anchor while the first page is in flight, so the
   * indicator has a cutoff to send from the very first render of replay.
   */
  cutoffTime: number | null;
  /** Full-series index (0-based) of the last bar held; null until it lands. */
  cutoffIndex: number | null;
  totalBars: number | null;
  /** No bar exists after the cutoff: stepping and playing are no-ops. */
  atEnd: boolean;
  /** Only the first loaded bar is left: stepping back is a no-op. */
  atStart: boolean;
  /** The "as of" page is in flight. */
  loading: boolean;
  /** One step is in flight. */
  stepping: boolean;
  /**
   * Whatever the API said, verbatim — e.g. "No bar at or before …; earliest
   * is …" for a date before the series starts — or the last step's error.
   */
  error: string | null;
  /** Enter replay anchored at `untilSeconds` (unix seconds, 00:00 server time). */
  start: (untilSeconds: number) => void;
  /** Back to the live tail. Clears the interval. */
  exit: () => void;
  togglePlay: () => void;
  pause: () => void;
  /** One bar forward. Safe to call while a step is already in flight. */
  step: () => void;
  /**
   * One bar back: drops the last bar held, no request. Pauses first when
   * playing — a loop that keeps appending while the user removes bars is
   * confusing. Refused silently while a forward step is in flight.
   */
  stepBack: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
}

export interface UseReplayOptions {
  /** The anchor the page holds and passes to `useCandleData`. */
  until: number | null;
  onUntilChange: (until: number | null) => void;
  /** The result of `useCandleData(timeframe, until)` — the same instance the chart draws. */
  candles: CandleDataResult;
}

/**
 * Same rule as the drawing shortcuts in `useDrawings`: a key pressed inside a
 * text field, a select or a contentEditable belongs to that field. The date
 * input and the inspector's number fields must never trigger a step.
 * (Duplicated rather than imported so this hook does not reach into the
 * drawings module for a five-line predicate.)
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useReplay({ until, onUntilChange, candles }: UseReplayOptions): ReplayControls {
  const [speed, setSpeed] = useState<ReplaySpeed>(DEFAULT_REPLAY_SPEED);
  const [playing, setPlaying] = useState(false);

  const active = until !== null;
  const {
    dataset,
    stepForward,
    stepBack: dropLastBar,
    loading,
    stepping,
    error,
    stepError,
  } = candles;

  const lastBar =
    dataset !== null && dataset.bars.length > 0 ? dataset.bars[dataset.bars.length - 1] : null;
  const cutoffTime = active ? (lastBar?.time ?? until) : null;
  const cutoffIndex =
    active && dataset !== null && dataset.bars.length > 0
      ? dataset.startIndex + dataset.bars.length - 1
      : null;
  const totalBars = active && dataset !== null ? dataset.totalBars : null;
  const atEnd = active && dataset !== null && !dataset.hasNewer;
  const atStart = active && dataset !== null && dataset.bars.length <= 1;

  const step = useCallback(() => {
    void stepForward().then((outcome) => {
      // Reaching the end pauses. The bar that WAS the last one has already
      // been appended by the time this resolves.
      if (outcome === 'end') setPlaying(false);
    });
  }, [stepForward]);

  const stepBack = useCallback(() => {
    // Pause BEFORE removing: the interval's cleanup runs on the re-render this
    // triggers, so no further forward step is scheduled after the user has
    // started walking back. (A step already in flight makes `dropLastBar`
    // refuse with `busy`; the next press lands.)
    setPlaying(false);
    dropLastBar();
  }, [dropLastBar]);

  /* ---- the play loop ---- */
  useEffect(() => {
    if (!active || !playing) return;
    const interval = setInterval(step, 1000 / speed);
    // Cleanup covers pause, speed change, exit AND unmount: no interval can
    // outlive the state that started it and keep fetching.
    return () => clearInterval(interval);
  }, [active, playing, speed, step]);

  const start = useCallback(
    (untilSeconds: number) => {
      setPlaying(false);
      onUntilChange(untilSeconds);
    },
    [onUntilChange],
  );

  const exit = useCallback(() => {
    setPlaying(false);
    onUntilChange(null);
  }, [onUntilChange]);

  const pause = useCallback(() => setPlaying(false), []);

  const togglePlay = useCallback(() => {
    if (!active || atEnd) {
      setPlaying(false);
      return;
    }
    setPlaying((current) => !current);
  }, [active, atEnd]);

  /* ---- keyboard: Space = play/pause, ArrowRight = step, ArrowLeft = step back; replay only ---- */
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === ' ' || event.code === 'Space') {
        // Stops the page scrolling — and stops a focused button (the one just
        // clicked) from firing its own click on keyup, which would toggle twice.
        event.preventDefault();
        togglePlay();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        step();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, togglePlay, step, stepBack]);

  return {
    active,
    playing: active && playing,
    speed,
    cutoffTime,
    cutoffIndex,
    totalBars,
    atEnd,
    atStart,
    loading: active && loading,
    stepping: active && stepping,
    error: active ? (error ?? stepError) : null,
    start,
    exit,
    togglePlay,
    pause,
    step,
    stepBack,
    setSpeed,
  };
}
