/**
 * Count mode — an opt-in running log of the positions you draw.
 *
 * While the mode is ON, every long/short position drawing is evaluated and
 * appended here, so a manual backtesting session produces a tally and a CSV
 * instead of a chart full of boxes you then have to re-read by eye.
 *
 * Deliberately separate from the Manual tab: that evaluates EVERY position
 * currently on the chart, on demand. This records what you drew WHILE counting
 * was on, in the order you drew it, and keeps it across reloads.
 */

import type { Timeframe } from '@/lib/candles/types';
import type { ManualOutcome } from '@/lib/counter/manualEval';
import type { Side } from '@/lib/counter/manualEval';

/** One logged trade. Mirrors `ManualTrade`, plus how and when it was logged. */
export interface CountedTrade {
  /** The drawing's id — the row and the box on the chart are the same trade. */
  id: string;
  /** Unix seconds when it was drawn, i.e. when you took the decision. */
  loggedAt: number;
  /** The chart timeframe it was drawn on. */
  timeframe: Timeframe;
  side: Side;
  entry: number;
  stop: number;
  target: number;
  riskPips: number;
  rewardPips: number;
  /** Reward / risk as drawn. Null when the stop sits on the entry. */
  plannedRR: number | null;
  /**
   * `open` means undecided as of the replay cutoff — it is re-evaluated as
   * replay advances. Outside replay a trade is never `open`.
   */
  outcome: ManualOutcome;
  entryTime?: number;
  exitTime?: number;
  exitPrice?: number;
  /** Realised, signed, net of spread. 1 pip = 0.01, so a $1 move is 100 pips. */
  pips?: number;
  /** Realised R, net of spread, where 1R = |entry − stop|. */
  r?: number;
  minutesHeld?: number;
  /** Plain-words explanation for `invalid` / `never_triggered`. */
  reason?: string;
}

/** The running tally. Only decided trades move the win rate. */
export interface CountSummary {
  total: number;
  /** wins + losses — the win rate's denominator, spelled out. */
  decided: number;
  wins: number;
  losses: number;
  open: number;
  expired: number;
  neverTriggered: number;
  invalid: number;
  /** Percent, 0..100, over wins + losses only. */
  winRate: number;
  totalPips: number;
  avgPips: number;
  totalR: number;
  expectancyR: number;
  /** Mean of the non-null planned R:R — what to judge the win rate against. */
  avgPlannedRR: number | null;
}

/** Bump when `CountedTrade` changes shape; unknown versions are discarded. */
export const COUNT_LOG_VERSION = 1;

export interface CountLogFile {
  version: number;
  symbol: string;
  enabled: boolean;
  trades: CountedTrade[];
}

/** Hard cap, so a long session cannot grow the log without bound. */
export const MAX_COUNTED_TRADES = 2000;
