import { describe, expect, it } from 'vitest';

import { summarise } from '@/lib/counter/summary';
import type { CountedTrade } from '@/lib/counter/types';

function trade(over: Partial<CountedTrade> & Pick<CountedTrade, 'id' | 'outcome'>): CountedTrade {
  return {
    loggedAt: 1_700_000_000,
    timeframe: 'M15',
    side: 'long',
    entry: 2000,
    stop: 1990,
    target: 2020,
    riskPips: 1000,
    rewardPips: 2000,
    plannedRR: 2,
    ...over,
  };
}

/**
 * Hand-computed fixture. Eight trades, one of every outcome plus an extra win
 * and loss, so every denominator differs from every other:
 *
 *   total            8
 *   decided (W+L)    3   → 2 wins / 1 loss → 66.666…%
 *   scoring (W+L+E)  4   → pips 300 + 180 − 100 − 40 = 340, avg 85
 *                        → R    1.5 + 0.9 − 1.0 − 0.4 = 1.0, expectancy 0.25
 *   plannedRR mean   over the 7 non-invalid rows: (2+3+1.5+2+2+2+2)/7 = 2.0714…
 */
const FIXTURE: CountedTrade[] = [
  trade({ id: 'w1', outcome: 'win', pips: 300, r: 1.5, plannedRR: 2 }),
  trade({ id: 'w2', outcome: 'win', pips: 180, r: 0.9, plannedRR: 3 }),
  trade({ id: 'l1', outcome: 'loss', pips: -100, r: -1, plannedRR: 1.5 }),
  trade({ id: 'e1', outcome: 'expired', pips: -40, r: -0.4, plannedRR: 2 }),
  trade({ id: 'o1', outcome: 'open', plannedRR: 2 }),
  trade({ id: 'o2', outcome: 'open', plannedRR: 2 }),
  trade({ id: 'n1', outcome: 'never_triggered', plannedRR: 2, reason: 'never reached entry' }),
  trade({ id: 'i1', outcome: 'invalid', plannedRR: 9, reason: 'stop above entry on a long' }),
];

describe('summarise', () => {
  it('returns a fully zeroed summary for an empty log, with no NaN', () => {
    const s = summarise([]);
    expect(s).toEqual({
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
    });
    for (const value of Object.values(s)) {
      expect(Number.isNaN(value as number)).toBe(false);
    }
  });

  it('counts every bucket', () => {
    const s = summarise(FIXTURE);
    expect(s.total).toBe(8);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.open).toBe(2);
    expect(s.expired).toBe(1);
    expect(s.neverTriggered).toBe(1);
    expect(s.invalid).toBe(1);
  });

  it('takes the win rate over wins + losses only', () => {
    const s = summarise(FIXTURE);
    expect(s.decided).toBe(3);
    expect(s.winRate).toBeCloseTo((2 / 3) * 100, 10);
  });

  it('totals pips and R over win + loss + expired, excluding open', () => {
    const s = summarise(FIXTURE);
    expect(s.totalPips).toBeCloseTo(340, 10);
    expect(s.avgPips).toBeCloseTo(85, 10);
    expect(s.totalR).toBeCloseTo(1, 10);
    expect(s.expectancyR).toBeCloseTo(0.25, 10);
  });

  it('averages planned R:R over the non-invalid rows', () => {
    const s = summarise(FIXTURE);
    expect(s.avgPlannedRR).toBeCloseTo((2 + 3 + 1.5 + 2 + 2 + 2 + 2) / 7, 10);
  });

  it('never divides by zero when every trade is still open', () => {
    const s = summarise([trade({ id: 'o', outcome: 'open' })]);
    expect(s.total).toBe(1);
    expect(s.open).toBe(1);
    expect(s.winRate).toBe(0);
    expect(s.avgPips).toBe(0);
    expect(s.expectancyR).toBe(0);
  });

  it('reports a null planned R:R when nothing has one', () => {
    const s = summarise([trade({ id: 'x', outcome: 'open', plannedRR: null })]);
    expect(s.avgPlannedRR).toBeNull();
  });

  it('is pure — it does not mutate or reorder its input', () => {
    const input = [...FIXTURE];
    const copy = JSON.parse(JSON.stringify(input)) as CountedTrade[];
    summarise(input);
    expect(input).toEqual(copy);
  });
});
