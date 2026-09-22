/**
 * Manual mode: evaluate hand-drawn position boxes against the real minute data.
 *
 * This is the trade-journal half of the tester. A `PositionDrawing` already
 * carries everything a trade needs — side, entry, stop, target, and the band's
 * own left and right edges as the start and the deadline — so the only new
 * logic here is *when the trade starts* and *when it is abandoned*. The
 * stop-versus-target question is answered exactly as `simulate.ts` answers it.
 *
 * Three rules govern this file.
 *
 * 1. EVALUATE ON M1 DIRECTLY. A hand-drawn position has an absolute time and an
 *    absolute price, so walking the minute series is both simpler and the most
 *    accurate answer the data supports. Ambiguity shrinks to inside one minute,
 *    which is as fine as the data goes; there is no coarser bar to replay.
 * 2. NEVER GUESS SILENTLY. A minute holding both the stop and the target is
 *    resolved pessimistically (stop first) and stamped `resolution: 'assumed'`,
 *    so the reader knows that number rests on an assumption.
 * 3. NEVER SCORE WHAT WAS NOT A TRADE. A position whose entry price price never
 *    reached is `never_triggered`, not a loss — it is a planning observation.
 *    A badly drawn box is `invalid`. Both are reported beside the win rate
 *    rather than folded into it.
 *
 * COST MODEL — identical to `simulate.ts`, deliberately, so the two engines'
 * numbers are comparable: half the M1 bar's spread against the trade at entry
 * and half at exit, converted from MT5 points at `POINT_SIZE` (0.001).
 *
 * DENOMINATORS — stated once, because the choice is the whole honesty story:
 *   - `winRate` is over `wins + losses` ONLY, matching the main engine. The
 *     three non-scoring categories are reported beside it so nothing is hidden.
 *   - `totalPips`, `avgPips`, `totalR` and `expectancyR` are over the trades
 *     that actually PRODUCED A RESULT: `win`, `loss` and `expired`. An expired
 *     position is a real position marked to market, so its P&L is real money
 *     and belongs in the total; `never_triggered` and `invalid` never had a
 *     fill, so they have no P&L to contribute and would only dilute the
 *     averages towards zero. An `open` position has not happened yet, so it is
 *     excluded from `winRate` and from all four P&L figures alike — counting an
 *     unfinished trade as anything but pending would be inventing a result.
 *   - `avgPlannedRR` is the mean of the non-null `plannedRR` values over the
 *     positions that were geometrically valid. An invalid box has distances but
 *     not a meaningful risk:reward, so averaging it in would be noise.
 *     There is deliberately no single breakeven win rate: every hand-drawn
 *     position has its own R:R, so the reader compares against this mean.
 *
 * REPLAY — `params.until` is a cutoff in unix seconds: only M1 bars at or
 * before it may be read, exactly as if the series ended there. It exists so bar
 * replay cannot spoil the exercise: a position drawn on the replay's leading
 * edge must read `open` until price has genuinely reached its stop or target.
 * A cutoff at or past a position's `endTime` is no cutoff at all — the whole
 * window has been seen, so the verdict is final and byte-identical to an
 * evaluation with no `until`.
 *
 * Pure given its inputs: no I/O, no caching, no mutation of the caller's arrays.
 *
 * Design: docs/superpowers/specs/2026-09-20-bigbody-strategy-tester-design.md,
 * "Addendum — Manual Mode".
 */

import type { CandleSeries } from '@/lib/candles/types';
import { PIP_SIZE, type PositionDrawing } from '@/lib/drawings/types';

/*
 * Self-contained by design.
 *
 * These four used to be shared with the Big Body strategy simulator, which has
 * been removed. They are small and stable, so they live here rather than in a
 * `common` module that would exist only to hold them.
 */

export type Side = 'long' | 'short';

/** How a position's exit was decided — an honesty field, always reported. */
export type Resolution =
  /** Only one of stop/target was inside the exit minute. No assumption needed. */
  | 'clean'
  /** Both were inside one bar; M1 replay decided the order. */
  | 'm1'
  /** Both were inside one MINUTE; the pessimistic rule decided. */
  | 'assumed'
  /** Closed at the deadline, or not resolved as of a replay cutoff. */
  | 'timeout';

/**
 * Price movement of one MT5 point for XAUUSDm.
 *
 * Verified two ways: the CSV quotes prices to three decimals
 * (`1771.84700000`), so one tick is 0.001; and the mean H1 spread of 197
 * points is $0.197, i.e. 197 x 0.001.
 */
export const POINT_SIZE = 0.001;

/**
 * First index `i` in `[0, count)` with `time[i] >= t`, or `count` when there is
 * none. Binary search, because M1 is 1.76M bars and a linear scan per position
 * would turn a sub-second evaluation into an unusable one.
 */
export function lowerBound(time: Int32Array, count: number, t: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    // (lo + hi) can exceed 2^31 for a large series; the explicit floor keeps
    // this correct for any count.
    const mid = lo + Math.floor((hi - lo) / 2);
    if (time[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type ManualOutcome =
  /**
   * Not resolved yet AS OF a cutoff. Only produced when `until` is given
   * (bar replay): price has not reached the stop or target by that moment, so
   * the outcome is genuinely unknown rather than expired. Never returned for a
   * full-history evaluation.
   */
  | 'open'
  | 'win'
  | 'loss'
  | 'expired'
  | 'never_triggered'
  | 'invalid';

export interface ManualTrade {
  /** The drawing's id, so the UI can select the box this verdict belongs to. */
  id: string;
  side: Side;
  entry: number;
  stop: number;
  target: number;
  riskPips: number;
  rewardPips: number;
  /** Reward / risk as drawn. Null when the stop sits on the entry. */
  plannedRR: number | null;
  outcome: ManualOutcome;
  resolution: Resolution;
  entryTime?: number;
  exitTime?: number;
  exitPrice?: number;
  /** Realised, signed, net of spread. 1 pip = 0.01, so a $1 move is 100 pips. */
  pips?: number;
  /** Realised R, net of spread, where 1R = |entry - stop|. */
  r?: number;
  minutesHeld?: number;
  /** Plain-words explanation for `invalid`, `never_triggered` and `open`. */
  reason?: string;
}

export interface ManualSummary {
  total: number;
  /** wins + losses — the win rate's denominator, spelled out. */
  evaluated: number;
  wins: number;
  losses: number;
  /** Not resolved yet as of `until`. Excluded from every figure below. */
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
  avgPlannedRR: number | null;
}

export interface ManualEvalParams {
  /** Charge the M1 bar's own spread, half at entry and half at exit. */
  includeSpread: boolean;
  /**
   * Replay cutoff, unix seconds, INCLUSIVE: no M1 bar later than this may be
   * read. Omit it to evaluate against the whole series. See the header.
   */
  until?: number;
}


/**
 * Why this box cannot be evaluated, in plain words, or null when it is sound.
 *
 * Long: `stop < entry < target`. Short: `target < entry < stop`. Equality
 * anywhere is invalid — a stop on the entry has no risk, so R is undefined, and
 * a target on the entry has no trade in it.
 */
function geometryProblem(p: PositionDrawing): string | null {
  if (
    !Number.isFinite(p.entry) ||
    !Number.isFinite(p.stop) ||
    !Number.isFinite(p.target) ||
    !Number.isFinite(p.time) ||
    !Number.isFinite(p.endTime)
  ) {
    return 'entry, stop, target, time and endTime must all be finite numbers';
  }

  if (p.endTime <= p.time) {
    return 'the position ends at or before it starts, so there is no window to test';
  }

  if (p.stop === p.entry) return 'stop is at entry, so the position risks nothing';
  if (p.target === p.entry) return 'target is at entry, so the position aims at nothing';

  if (p.side === 'long') {
    if (p.stop > p.entry) return 'stop is above entry on a long';
    if (p.target < p.entry) return 'target is below entry on a long';
    return null;
  }

  if (p.stop < p.entry) return 'stop is below entry on a short';
  if (p.target > p.entry) return 'target is above entry on a short';
  return null;
}

/** Spread in MT5 points at bar `i`; treated as zero when the column is absent. */
function spreadAt(spread: Int32Array, i: number): number {
  if (i < 0 || i >= spread.length) return 0;
  const v = spread[i];
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** How the walk forward from the entry minute ended. */
interface Exit {
  index: number;
  price: number;
  outcome: 'win' | 'loss' | 'expired';
  resolution: Resolution;
}

/**
 * Walk the minutes from `entryIndex` while `time < endTime`, testing stop and
 * target with the side-dependent comparisons — inclusive on both ends, exactly
 * as `simulate.ts` and `intrabar.ts` test them.
 *
 * `limit` is an exclusive index bound: the first bar past the replay cutoff, or
 * `m1.count` when there is none. `truncated` says the walk may not see the
 * whole window, in which case running out of bars means UNRESOLVED (null), not
 * expired — the deadline has not actually arrived, we simply cannot see that
 * far yet.
 */
function findExit(
  m1: CandleSeries,
  p: PositionDrawing,
  entryIndex: number,
  limit: number,
  truncated: boolean,
): Exit | null {
  const isLong = p.side === 'long';
  // `time` is no longer read here: the scan runs to `limit`, not to a deadline.
  const { high, low, close } = m1;
  const count = limit;

  let last = entryIndex;
  // Deliberately NOT bounded by `p.endTime`. The box's right edge is how long
  // you would wait for the ENTRY; once filled, the trade is decided by which
  // level price actually touches first. Stopping at the edge made almost every
  // drawn setup `expired` instead of a win or a loss.
  for (let i = entryIndex; i < count; i++) {
    last = i;

    const hitStop = isLong ? low[i] <= p.stop : high[i] >= p.stop;
    const hitTarget = isLong ? high[i] >= p.target : low[i] <= p.target;

    // Both inside ONE MINUTE. There is no finer series to replay, so the
    // pessimistic assumption decides and the trade says so.
    if (hitStop && hitTarget) {
      return { index: i, price: p.stop, outcome: 'loss', resolution: 'assumed' };
    }
    if (hitStop) return { index: i, price: p.stop, outcome: 'loss', resolution: 'clean' };
    if (hitTarget) return { index: i, price: p.target, outcome: 'win', resolution: 'clean' };
  }

  // The replay has simply not got there yet — the outcome is unknown, and
  // saying "expired" here would be inventing a deadline that has not passed.
  if (truncated) return null;

  // The DATA ran out with neither level touched — the trade is still running at
  // the edge of history. Marked to market at the last minute available, never
  // silently dropped.
  return { index: last, price: close[last], outcome: 'expired', resolution: 'timeout' };
}

function evaluateOne(
  m1: CandleSeries,
  p: PositionDrawing,
  params: ManualEvalParams,
): ManualTrade {
  const riskPrice = Math.abs(p.entry - p.stop);
  const rewardPrice = Math.abs(p.target - p.entry);

  const planned = {
    id: p.id,
    side: p.side,
    entry: p.entry,
    stop: p.stop,
    target: p.target,
    riskPips: riskPrice / PIP_SIZE,
    rewardPips: rewardPrice / PIP_SIZE,
    plannedRR: riskPrice > 0 ? rewardPrice / riskPrice : null,
  };

  /* 1. Geometry. A badly drawn box is reported, never silently scored. */
  const problem = geometryProblem(p);
  if (problem !== null) {
    // Non-finite inputs poison the pip arithmetic above, so blank it out.
    const finite = Number.isFinite(planned.riskPips) && Number.isFinite(planned.rewardPips);
    return {
      ...planned,
      riskPips: finite ? planned.riskPips : 0,
      rewardPips: finite ? planned.rewardPips : 0,
      plannedRR: finite ? planned.plannedRR : null,
      outcome: 'invalid',
      resolution: 'timeout',
      reason: problem,
    };
  }

  /**
   * 2. The replay cutoff.
   *
   * It is NEVER dropped on account of the deadline. The exit scan now runs
   * past the box's right edge, so a cutoff sitting beyond that edge still
   * hides future minutes — discarding it there would let a trade resolve on
   * bars the replay has not reached yet, which is look-ahead of exactly the
   * kind this file exists to avoid. A cutoff at or past the last loaded minute
   * covers the whole series and is equivalent to no cutoff on its own, with no
   * special case needed.
   */
  const { time, high, low, count } = m1;
  const cutoff =
    params.until !== undefined && Number.isFinite(params.until) ? params.until : undefined;

  /**
   * Whether the ENTRY window has been seen in full.
   *
   * `never_triggered` is a verdict about the whole entry window, so it may only
   * be given once every minute of it is visible. Times are whole seconds, so a
   * cutoff of `endTime - 1` already covers every bar with `time < endTime`.
   */
  const entryWindowSeen = cutoff === undefined || cutoff + 1 >= p.endTime;

  if (cutoff !== undefined && cutoff < p.time) {
    return {
      ...planned,
      outcome: 'open',
      resolution: 'timeout',
      reason: 'the replay has not reached the start of this position yet',
    };
  }

  // First bar strictly past the cutoff — the same binary search the window
  // search uses, so the scan below never walks a minute it may not see.
  const limit =
    cutoff === undefined ? count : Math.min(count, lowerBound(time, count, cutoff + 1));

  /* 3. The entry: the first minute in the window whose range contains it. */
  const first = lowerBound(time, count, p.time);

  // "No data at all" and "price never got there" are different facts and the
  // reader is told which one happened — but neither is final while the replay
  // still has window left to show.
  if (first >= limit || time[first] >= p.endTime) {
    if (!entryWindowSeen) {
      return {
        ...planned,
        outcome: 'open',
        resolution: 'timeout',
        reason: 'no minute data inside this window up to the replay cutoff yet',
      };
    }
    return {
      ...planned,
      outcome: 'never_triggered',
      resolution: 'timeout',
      reason:
        'no minute data inside this window — the market was closed, or the window lies outside the loaded series',
    };
  }

  let entryIndex = -1;
  for (let i = first; i < limit && time[i] < p.endTime; i++) {
    if (low[i] <= p.entry && p.entry <= high[i]) {
      entryIndex = i;
      break;
    }
  }

  if (entryIndex < 0) {
    // `never_triggered` is a verdict about the WHOLE entry window, so it may
    // only be returned once that window has been seen in full.
    if (!entryWindowSeen) {
      return {
        ...planned,
        outcome: 'open',
        resolution: 'timeout',
        reason: `price has not reached the entry at ${p.entry} yet`,
      };
    }
    return {
      ...planned,
      outcome: 'never_triggered',
      resolution: 'timeout',
      reason: `price never reached the entry at ${p.entry} inside this window`,
    };
  }

  /* 4-5. Walk forward to the stop, the target, the end of data — or the cutoff. */
  // `truncated` means minutes are actually being HIDDEN, not merely that a
  // cutoff was supplied: a cutoff at or past the last loaded minute conceals
  // nothing, so the verdict there must match an uncut evaluation exactly.
  const exit = findExit(m1, p, entryIndex, limit, limit < count);

  // Filled, but neither level reached by the cutoff. The fill is a fact, so it
  // is reported; there is no P&L yet, so none is.
  if (exit === null) {
    return {
      ...planned,
      outcome: 'open',
      resolution: 'timeout',
      entryTime: time[entryIndex],
      reason: 'filled, but neither the stop nor the target has been reached yet',
    };
  }

  /* 6. Costs: half a spread against us at entry, half at exit — one round trip. */
  const spreadCost = params.includeSpread
    ? (spreadAt(m1.spread, entryIndex) + spreadAt(m1.spread, exit.index)) * 0.5 * POINT_SIZE
    : 0;

  const grossMove =
    p.side === 'long' ? exit.price - p.entry : p.entry - exit.price;
  const netMove = grossMove - spreadCost;

  return {
    ...planned,
    outcome: exit.outcome,
    resolution: exit.resolution,
    entryTime: time[entryIndex],
    exitTime: time[exit.index],
    exitPrice: exit.price,
    pips: netMove / PIP_SIZE,
    r: netMove / riskPrice,
    minutesHeld: exit.index - entryIndex,
  };
}

const EMPTY_SUMMARY: ManualSummary = {
  total: 0,
  evaluated: 0,
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

function summarise(trades: readonly ManualTrade[]): ManualSummary {
  let wins = 0;
  let losses = 0;
  let open = 0;
  let expired = 0;
  let neverTriggered = 0;
  let invalid = 0;

  let totalPips = 0;
  let totalR = 0;
  /** Trades that produced a result: win + loss + expired. See the header. */
  let scored = 0;

  let rrSum = 0;
  let rrCount = 0;

  for (const t of trades) {
    switch (t.outcome) {
      case 'win': wins += 1; break;
      case 'loss': losses += 1; break;
      case 'open': open += 1; break;
      case 'expired': expired += 1; break;
      case 'never_triggered': neverTriggered += 1; break;
      case 'invalid': invalid += 1; break;
    }

    if (t.outcome !== 'invalid' && t.plannedRR !== null) {
      rrSum += t.plannedRR;
      rrCount += 1;
    }

    if (t.pips !== undefined && t.r !== undefined) {
      totalPips += t.pips;
      totalR += t.r;
      scored += 1;
    }
  }

  const evaluated = wins + losses;

  return {
    total: trades.length,
    evaluated,
    wins,
    losses,
    open,
    expired,
    neverTriggered,
    invalid,
    winRate: evaluated > 0 ? (wins / evaluated) * 100 : 0,
    totalPips,
    avgPips: scored > 0 ? totalPips / scored : 0,
    totalR,
    expectancyR: scored > 0 ? totalR / scored : 0,
    avgPlannedRR: rrCount > 0 ? rrSum / rrCount : null,
  };
}

/**
 * Evaluate hand-drawn positions against the minute series.
 *
 * Input order is preserved, one `ManualTrade` per position, so the UI can pair
 * a verdict with the box it came from by index as well as by id.
 */
export function evaluateManualPositions(
  m1: CandleSeries,
  positions: readonly PositionDrawing[],
  params: ManualEvalParams,
): { trades: ManualTrade[]; summary: ManualSummary } {
  if (positions.length === 0) return { trades: [], summary: { ...EMPTY_SUMMARY } };

  const trades = positions.map((p) => evaluateOne(m1, p, params));
  return { trades, summary: summarise(trades) };
}
