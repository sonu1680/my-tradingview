/**
 * The Count-mode tally.
 *
 * Pure: `summarise` is a fold over the logged trades and nothing else. It is
 * recomputed from the log on every render rather than stored, so a row that is
 * re-evaluated as replay advances can never leave a stale total behind.
 *
 * DENOMINATORS — the same choices `lib/counter/manualEval.ts` makes, restated
 * here because this file is what the badge and the tiles actually read:
 *
 *   - `winRate` is over `wins + losses` ONLY (`decided`). `open`, `expired`,
 *     `neverTriggered` and `invalid` are all outside it, and each is reported
 *     beside the rate so nothing is hidden by the exclusion.
 *   - `totalPips`, `avgPips`, `totalR` and `expectancyR` are over the trades
 *     that PRODUCED A RESULT: `win`, `loss` and `expired`. An expired position
 *     is a real position marked to market, so its P&L is real. `open` has not
 *     happened yet, and `neverTriggered` / `invalid` never filled, so all three
 *     would only dilute the averages towards zero.
 *   - `avgPlannedRR` is the mean of the non-null `plannedRR` over the
 *     geometrically valid boxes. An `invalid` box has distances but no
 *     meaningful risk:reward, so averaging it in would be noise.
 *
 * Empty input returns every number as 0 and `avgPlannedRR` as null — never
 * NaN, which would render as "NaN%" in the badge.
 */

import type { CountSummary, CountedTrade } from './types';

/** Outcomes whose pips/R are real money and belong in the totals. */
const SCORING = new Set(['win', 'loss', 'expired']);

const EMPTY: CountSummary = {
  total: 0,
  decided: 0,
  wins: 0,
  losses: 0,
  open: 0,
  expired: 0,
  neverTriggered: 0,
  invalid: 0,
  winRate: 0,
  totalPips: 0,
  avgPips: 0,
  totalR: 0,
  expectancyR: 0,
  avgPlannedRR: null,
};

/** A fresh zeroed summary. Never shared — callers may hold it across renders. */
export function emptySummary(): CountSummary {
  return { ...EMPTY };
}

export function summarise(trades: readonly CountedTrade[]): CountSummary {
  if (trades.length === 0) return emptySummary();

  let wins = 0;
  let losses = 0;
  let open = 0;
  let expired = 0;
  let neverTriggered = 0;
  let invalid = 0;

  let scored = 0;
  let totalPips = 0;
  let totalR = 0;

  let rrCount = 0;
  let rrSum = 0;

  for (const trade of trades) {
    switch (trade.outcome) {
      case 'win':
        wins += 1;
        break;
      case 'loss':
        losses += 1;
        break;
      case 'open':
        open += 1;
        break;
      case 'expired':
        expired += 1;
        break;
      case 'never_triggered':
        neverTriggered += 1;
        break;
      case 'invalid':
        invalid += 1;
        break;
    }

    if (SCORING.has(trade.outcome)) {
      scored += 1;
      // A scoring outcome always carries pips and R, but the log is read back
      // out of localStorage: a missing field degrades to 0 rather than NaN.
      if (typeof trade.pips === 'number' && Number.isFinite(trade.pips)) {
        totalPips += trade.pips;
      }
      if (typeof trade.r === 'number' && Number.isFinite(trade.r)) {
        totalR += trade.r;
      }
    }

    if (
      trade.outcome !== 'invalid' &&
      trade.plannedRR !== null &&
      Number.isFinite(trade.plannedRR)
    ) {
      rrCount += 1;
      rrSum += trade.plannedRR;
    }
  }

  const decided = wins + losses;

  return {
    total: trades.length,
    decided,
    wins,
    losses,
    open,
    expired,
    neverTriggered,
    invalid,
    winRate: decided === 0 ? 0 : (wins / decided) * 100,
    totalPips,
    avgPips: scored === 0 ? 0 : totalPips / scored,
    totalR,
    expectancyR: scored === 0 ? 0 : totalR / scored,
    avgPlannedRR: rrCount === 0 ? null : rrSum / rrCount,
  };
}
