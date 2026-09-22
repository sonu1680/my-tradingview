import { describe, expect, it } from 'vitest';

import type { CandleSeries } from '@/lib/candles/types';
import { DEFAULT_STYLE, type PositionDrawing } from '@/lib/drawings/types';

import { evaluateManualPositions } from './manualEval';

/* ---------- Fixtures ---------- */

/** [time, open, high, low, close] */
type Row = readonly [number, number, number, number, number];

const MIN = 60;
/** 2024.01.02 00:00 UTC — a Tuesday. */
const T0 = Date.UTC(2024, 0, 2, 0, 0) / 1000;

/**
 * Hand-built M1 series. `spreadPoints` is the MT5 spread charged on EVERY bar,
 * so the arithmetic in the assertions stays doable by hand; zero by default.
 */
function makeM1(rows: readonly Row[], spreadPoints = 0): CandleSeries {
  const n = rows.length;
  const time = new Int32Array(n);
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const volume = new Int32Array(n);
  const spread = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    [time[i], open[i], high[i], low[i], close[i]] = rows[i];
    volume[i] = 1;
    spread[i] = spreadPoints;
  }
  return {
    timeframe: 'M1',
    time, open, high, low, close, volume, spread,
    count: n,
    skippedRows: 0,
  };
}

const EMPTY_M1 = makeM1([]);

let seq = 0;
function position(over: Partial<PositionDrawing> = {}): PositionDrawing {
  seq += 1;
  return {
    id: `p${seq}`,
    kind: 'position',
    style: DEFAULT_STYLE,
    createdAt: 0,
    side: 'long',
    time: T0,
    endTime: T0 + 10 * MIN,
    entry: 2000,
    stop: 1998,
    target: 2004,
    lots: 0.01,
    ...over,
  };
}

/** A bar that trades in a tight range around `mid` and touches nothing. */
function quiet(i: number, mid: number, close = mid): Row {
  return [T0 + i * MIN, mid, mid + 0.5, mid - 0.5, close];
}

/**
 * Ten quiet minutes straddling 2000: bar 0 contains the 2000 entry, and no bar
 * reaches 1998 or 2004, so the caller can drop one decisive bar into the middle.
 */
function baseRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 10; i++) rows.push(quiet(i, 2000, 2000));
  return rows;
}

const NO_SPREAD = { includeSpread: false } as const;

/* ---------- Clean outcomes ---------- */

describe('evaluateManualPositions — clean outcomes', () => {
  it('scores a long that reaches its target as a clean win', () => {
    const rows = baseRows();
    rows[3] = [T0 + 3 * MIN, 2000, 2004.5, 1999.5, 2004.2]; // target only
    const m1 = makeM1(rows);

    const { trades } = evaluateManualPositions(m1, [position()], NO_SPREAD);
    const t = trades[0];

    expect(t.outcome).toBe('win');
    expect(t.resolution).toBe('clean');
    expect(t.entryTime).toBe(T0);
    expect(t.exitTime).toBe(T0 + 3 * MIN);
    expect(t.exitPrice).toBe(2004);
    expect(t.minutesHeld).toBe(3);
    // $4 move at 0.01 per pip.
    expect(t.pips).toBeCloseTo(400, 9);
    expect(t.r).toBeCloseTo(2, 9);
  });

  it('scores a long that reaches its stop as a clean loss', () => {
    const rows = baseRows();
    rows[3] = [T0 + 3 * MIN, 2000, 2000.5, 1997.5, 1997.8]; // stop only
    const m1 = makeM1(rows);

    const { trades } = evaluateManualPositions(m1, [position()], NO_SPREAD);
    const t = trades[0];

    expect(t.outcome).toBe('loss');
    expect(t.resolution).toBe('clean');
    expect(t.exitPrice).toBe(1998);
    expect(t.pips).toBeCloseTo(-200, 9);
    expect(t.r).toBeCloseTo(-1, 9);
  });

  it('scores a short that reaches its target as a clean win', () => {
    const rows = baseRows();
    rows[4] = [T0 + 4 * MIN, 2000, 2000.5, 1995.5, 1995.8];
    const m1 = makeM1(rows);

    const short = position({ side: 'short', stop: 2002, target: 1996 });
    const { trades } = evaluateManualPositions(m1, [short], NO_SPREAD);
    const t = trades[0];

    expect(t.outcome).toBe('win');
    expect(t.resolution).toBe('clean');
    expect(t.exitPrice).toBe(1996);
    expect(t.pips).toBeCloseTo(400, 9);
    expect(t.r).toBeCloseTo(2, 9);
  });

  it('scores a short that reaches its stop as a clean loss', () => {
    const rows = baseRows();
    rows[4] = [T0 + 4 * MIN, 2000, 2002.5, 1999.5, 2002.2];
    const m1 = makeM1(rows);

    const short = position({ side: 'short', stop: 2002, target: 1996 });
    const { trades } = evaluateManualPositions(m1, [short], NO_SPREAD);
    const t = trades[0];

    expect(t.outcome).toBe('loss');
    expect(t.resolution).toBe('clean');
    expect(t.exitPrice).toBe(2002);
    expect(t.pips).toBeCloseTo(-200, 9);
    expect(t.r).toBeCloseTo(-1, 9);
  });

  it('does not start the trade before the drawing does', () => {
    const rows = baseRows();
    rows[1] = [T0 + 1 * MIN, 2000, 2004.5, 1999.5, 2004.2]; // target, but too early
    rows[6] = [T0 + 6 * MIN, 2000, 2004.5, 1999.5, 2004.2];
    const m1 = makeM1(rows);

    const late = position({ time: T0 + 3 * MIN });
    const { trades } = evaluateManualPositions(m1, [late], NO_SPREAD);

    expect(trades[0].entryTime).toBe(T0 + 3 * MIN);
    expect(trades[0].exitTime).toBe(T0 + 6 * MIN);
  });
});

/* ---------- Same-minute ambiguity ---------- */

describe('evaluateManualPositions — same-minute collision', () => {
  it('resolves a minute holding both stop and target pessimistically', () => {
    const rows = baseRows();
    rows[3] = [T0 + 3 * MIN, 2000, 2004.5, 1997.5, 2000]; // both inside one minute
    const m1 = makeM1(rows);

    const { trades } = evaluateManualPositions(m1, [position()], NO_SPREAD);
    const t = trades[0];

    expect(t.outcome).toBe('loss');
    expect(t.resolution).toBe('assumed');
    expect(t.exitPrice).toBe(1998);
    expect(t.r).toBeCloseTo(-1, 9);
  });

  /**
   * The FILL minute, specifically. `simulate.ts` now enters the entry bar at
   * the minute of the touch and applies exactly this rule there; manual mode
   * has always started its walk at the fill minute, so the two engines agree
   * and this test pins that agreement down.
   */
  it('applies the same rule inside the FILL minute itself', () => {
    const rows = baseRows();
    // Minute 0 is the fill minute (it contains the 2000 entry) and it also
    // holds the 1998 stop and the 2004 target.
    rows[0] = [T0, 2000, 2004.5, 1997.5, 2000];
    const m1 = makeM1(rows);

    const { trades } = evaluateManualPositions(m1, [position()], NO_SPREAD);
    const t = trades[0];

    expect(t.entryTime).toBe(T0);
    expect(t.exitTime).toBe(T0);
    expect(t.minutesHeld).toBe(0);
    expect(t.outcome).toBe('loss');
    expect(t.resolution).toBe('assumed');
    expect(t.exitPrice).toBe(1998);
    expect(t.r).toBeCloseTo(-1, 9);
  });

  it('mirrors the pessimistic rule for a short', () => {
    const rows = baseRows();
    rows[3] = [T0 + 3 * MIN, 2000, 2002.5, 1995.5, 2000];
    const m1 = makeM1(rows);

    const short = position({ side: 'short', stop: 2002, target: 1996 });
    const { trades } = evaluateManualPositions(m1, [short], NO_SPREAD);

    expect(trades[0].outcome).toBe('loss');
    expect(trades[0].resolution).toBe('assumed');
    expect(trades[0].exitPrice).toBe(2002);
  });
});

/* ---------- Expiry ---------- */

describe('evaluateManualPositions — expiry', () => {
  it('marks to market at the last minute of DATA when neither level is reached', () => {
    const rows = baseRows();
    rows[9] = quiet(9, 2000, 2001); // the last minute in the series
    const m1 = makeM1(rows);

    // The box ends at bar 5, but nothing is touched, so the trade runs on to
    // the end of the data rather than expiring at the box's edge.
    const p = position({ endTime: T0 + 5 * MIN });
    const { trades } = evaluateManualPositions(m1, [p], NO_SPREAD);
    const t = trades[0];

    expect(t.outcome).toBe('expired');
    expect(t.resolution).toBe('timeout');
    expect(t.exitTime).toBe(T0 + 9 * MIN);
    expect(t.exitPrice).toBe(2001);
    // A $1 move is 100 pips; risk is $2, so half an R.
    expect(t.pips).toBeCloseTo(100, 9);
    expect(t.r).toBeCloseTo(0.5, 9);
    expect(t.minutesHeld).toBe(9);
  });

  it('resolves on a bar AFTER the box ends — the edge only bounds the entry', () => {
    const rows = baseRows();
    rows[7] = [T0 + 7 * MIN, 2000, 2004.5, 1999.5, 2004.2]; // target, past endTime
    const m1 = makeM1(rows);

    const p = position({ endTime: T0 + 5 * MIN });
    const t = evaluateManualPositions(m1, [p], NO_SPREAD).trades[0];

    // The old rule called this `expired`, which is why almost every drawn
    // setup scored as a non-result instead of a win or a loss.
    expect(t.outcome).toBe('win');
    expect(t.exitTime).toBe(T0 + 7 * MIN);
  });

  it('still bounds the ENTRY by the box, so a late fill never triggers', () => {
    const rows = baseRows().map(
      (r, i) => [T0 + i * MIN, 2010, 2011, 2009, 2010] as Row,
    );
    // Price only comes back to the entry after the box has closed.
    rows[7] = [T0 + 7 * MIN, 2010, 2010.5, 1999.5, 2004.2];
    const m1 = makeM1(rows);

    const p = position({ endTime: T0 + 5 * MIN });
    expect(evaluateManualPositions(m1, [p], NO_SPREAD).trades[0].outcome).toBe(
      'never_triggered',
    );
  });
});

/* ---------- Never triggered ---------- */

describe('evaluateManualPositions — never triggered', () => {
  it('reports a position whose entry price price never reached', () => {
    const rows = baseRows().map(
      (r, i) => [T0 + i * MIN, 2010, 2011, 2009, 2010] as Row,
    );
    const m1 = makeM1(rows);

    const { trades, summary } = evaluateManualPositions(m1, [position()], NO_SPREAD);
    const t = trades[0];

    expect(t.outcome).toBe('never_triggered');
    expect(t.resolution).toBe('timeout');
    expect(t.entryTime).toBeUndefined();
    expect(t.pips).toBeUndefined();
    expect(t.r).toBeUndefined();
    expect(t.reason).toMatch(/never reached the entry/i);
    // A planning observation, never a loss.
    expect(summary.losses).toBe(0);
    expect(summary.neverTriggered).toBe(1);
  });

  it('distinguishes "no minute data" from "price never got there"', () => {
    const m1 = makeM1(baseRows());

    // A window entirely past the end of the series.
    const p = position({ time: T0 + 500 * MIN, endTime: T0 + 600 * MIN });
    const t = evaluateManualPositions(m1, [p], NO_SPREAD).trades[0];

    expect(t.outcome).toBe('never_triggered');
    expect(t.reason).toMatch(/no minute data/i);
    expect(t.reason).not.toMatch(/never reached the entry/i);
  });

  it('reports no minute data for an empty series', () => {
    const t = evaluateManualPositions(EMPTY_M1, [position()], NO_SPREAD).trades[0];
    expect(t.outcome).toBe('never_triggered');
    expect(t.reason).toMatch(/no minute data/i);
  });
});

/* ---------- Invalid geometry ---------- */

describe('evaluateManualPositions — invalid geometry', () => {
  const m1 = makeM1(baseRows());

  function reasonFor(over: Partial<PositionDrawing>): string {
    const t = evaluateManualPositions(m1, [position(over)], NO_SPREAD).trades[0];
    expect(t.outcome).toBe('invalid');
    expect(t.resolution).toBe('timeout');
    expect(t.pips).toBeUndefined();
    expect(t.r).toBeUndefined();
    return t.reason ?? '';
  }

  it('rejects a long whose stop is above entry', () => {
    expect(reasonFor({ stop: 2001 })).toMatch(/stop is above entry on a long/i);
  });

  it('rejects a long whose target is below entry', () => {
    expect(reasonFor({ target: 1999 })).toMatch(/target is below entry on a long/i);
  });

  it('rejects a short whose stop is below entry', () => {
    expect(
      reasonFor({ side: 'short', stop: 1998, target: 1996 }),
    ).toMatch(/stop is below entry on a short/i);
  });

  it('rejects a short whose target is above entry', () => {
    expect(
      reasonFor({ side: 'short', stop: 2002, target: 2004 }),
    ).toMatch(/target is above entry on a short/i);
  });

  it('rejects a stop sitting exactly on entry', () => {
    expect(reasonFor({ stop: 2000 })).toMatch(/stop is at entry/i);
  });

  it('rejects a target sitting exactly on entry', () => {
    expect(reasonFor({ target: 2000 })).toMatch(/target is at entry/i);
  });

  it('rejects a window that ends at or before it starts', () => {
    expect(reasonFor({ endTime: T0 })).toMatch(/ends at or before it starts/i);
    expect(reasonFor({ endTime: T0 - MIN })).toMatch(/ends at or before it starts/i);
  });

  it('rejects non-finite numbers', () => {
    expect(reasonFor({ entry: Number.NaN })).toMatch(/finite numbers/i);
    expect(reasonFor({ target: Number.POSITIVE_INFINITY })).toMatch(/finite numbers/i);
    expect(reasonFor({ endTime: Number.NaN })).toMatch(/finite numbers/i);
  });

  it('keeps invalid positions out of the win rate', () => {
    const rows = baseRows();
    rows[3] = [T0 + 3 * MIN, 2000, 2004.5, 1999.5, 2004.2];
    const series = makeM1(rows);

    const { summary } = evaluateManualPositions(
      series,
      [position(), position({ stop: 2001 })],
      NO_SPREAD,
    );

    expect(summary.total).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(summary.winRate).toBe(100);
  });
});

/* ---------- Costs ---------- */

describe('evaluateManualPositions — spread', () => {
  const rows = baseRows();
  rows[3] = [T0 + 3 * MIN, 2000, 2004.5, 1999.5, 2004.2];
  // 20 MT5 points = $0.02; half at entry and half at exit is $0.02 round trip.
  const m1 = makeM1(rows, 20);

  it('lands a 2R win strictly under +2.000R', () => {
    const t = evaluateManualPositions(m1, [position()], { includeSpread: true }).trades[0];
    expect(t.outcome).toBe('win');
    expect(t.r).toBeLessThan(2);
    // (4 - 0.02) / 2
    expect(t.r).toBeCloseTo(1.99, 9);
    expect(t.pips).toBeCloseTo(398, 9);
  });

  it('charges the spread against a short too', () => {
    const shortRows = baseRows();
    shortRows[3] = [T0 + 3 * MIN, 2000, 2000.5, 1995.5, 1995.8];
    const shortM1 = makeM1(shortRows, 20);
    const short = position({ side: 'short', stop: 2002, target: 1996 });

    const t = evaluateManualPositions(shortM1, [short], { includeSpread: true }).trades[0];
    expect(t.r).toBeLessThan(2);
    expect(t.r).toBeCloseTo(1.99, 9);
  });

  it('makes a loss worse, never better', () => {
    const lossRows = baseRows();
    lossRows[3] = [T0 + 3 * MIN, 2000, 2000.5, 1997.5, 1997.8];
    const lossM1 = makeM1(lossRows, 20);

    const t = evaluateManualPositions(lossM1, [position()], { includeSpread: true }).trades[0];
    expect(t.r).toBeLessThan(-1);
    expect(t.r).toBeCloseTo(-1.01, 9);
  });

  it('charges nothing when includeSpread is false', () => {
    const t = evaluateManualPositions(m1, [position()], NO_SPREAD).trades[0];
    expect(t.r).toBeCloseTo(2, 9);
  });
});

/* ---------- Planned geometry ---------- */

describe('evaluateManualPositions — planned risk and reward', () => {
  const m1 = makeM1(baseRows());

  it('reports risk and reward in pips, with 1 pip = 0.01', () => {
    const t = evaluateManualPositions(m1, [position()], NO_SPREAD).trades[0];
    expect(t.riskPips).toBeCloseTo(200, 9);
    expect(t.rewardPips).toBeCloseTo(400, 9);
    expect(t.plannedRR).toBeCloseTo(2, 9);
  });

  it('reports a null planned R:R at zero risk', () => {
    const t = evaluateManualPositions(m1, [position({ stop: 2000 })], NO_SPREAD).trades[0];
    expect(t.plannedRR).toBeNull();
  });

  it('averages the planned R:R across valid positions', () => {
    const rows = baseRows();
    rows[3] = [T0 + 3 * MIN, 2000, 2004.5, 1999.5, 2004.2];
    const series = makeM1(rows);

    const { summary } = evaluateManualPositions(
      series,
      [
        position(), // 2:1
        position({ stop: 1998, target: 2010 }), // 5:1
      ],
      NO_SPREAD,
    );

    expect(summary.avgPlannedRR).toBeCloseTo(3.5, 9);
  });

  it('reports a null average when nothing has a planned R:R', () => {
    const { summary } = evaluateManualPositions(
      m1,
      [position({ stop: 2000 })],
      NO_SPREAD,
    );
    expect(summary.avgPlannedRR).toBeNull();
  });
});

/* ---------- Summary ---------- */

describe('evaluateManualPositions — summary', () => {
  /** One of each outcome, so every denominator rule is exercised at once. */
  function mixed() {
    const winRows = baseRows();
    winRows[3] = [T0 + 3 * MIN, 2000, 2004.5, 1999.5, 2004.2];
    const m1 = makeM1(winRows);

    const positions: PositionDrawing[] = [
      position({ id: 'win' }),
      // Expired: levels this series never touches, so it runs out of data.
      position({ id: 'expired', stop: 1990, target: 2010 }),
      position({ id: 'never', entry: 2050, stop: 2040, target: 2070 }),
      position({ id: 'invalid', stop: 2001 }),
    ];
    return { m1, positions };
  }

  it('counts every category and hides none', () => {
    const { m1, positions } = mixed();
    const { trades, summary } = evaluateManualPositions(m1, positions, NO_SPREAD);

    expect(trades.map((t) => t.id)).toEqual(['win', 'expired', 'never', 'invalid']);
    expect(summary.total).toBe(4);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(0);
    expect(summary.expired).toBe(1);
    expect(summary.neverTriggered).toBe(1);
    expect(summary.invalid).toBe(1);
    // wins + losses only.
    expect(summary.evaluated).toBe(1);
    expect(summary.winRate).toBe(100);
  });

  it('excludes the three non-scoring categories from the win rate', () => {
    const rows = baseRows();
    rows[3] = [T0 + 3 * MIN, 2000, 2004.5, 1999.5, 2004.2];
    const winM1 = makeM1(rows);

    const lossRows = baseRows();
    lossRows[3] = [T0 + 3 * MIN, 2000, 2000.5, 1997.5, 1997.8];

    // One win and one loss on the winning series plus three non-scoring
    // positions: the win rate must stay 50, not 20.
    const { summary } = evaluateManualPositions(
      winM1,
      [
        position(), // win
        position({ side: 'short', stop: 2002, target: 1996 }), // stop at 2004.5 -> loss
        position({ stop: 1990, target: 2010 }), // expired — never touched
        position({ entry: 2050, stop: 2040, target: 2070 }), // never triggered
        position({ target: 1999 }), // invalid
      ],
      NO_SPREAD,
    );

    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.expired).toBe(1);
    expect(summary.neverTriggered).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(summary.winRate).toBe(50);
  });

  it('totals pips and R over win, loss and expired only', () => {
    const rows = baseRows();
    rows[3] = [T0 + 3 * MIN, 2000, 2004.5, 1999.5, 2004.2];
    const m1 = makeM1(rows);

    const { summary } = evaluateManualPositions(
      m1,
      [
        position(), // win: +400 pips, +2R
        position({ stop: 1990, target: 2010 }), // expired at 2000 close: 0 pips, 0R
        position({ entry: 2050, stop: 2040, target: 2070 }), // never triggered
        position({ stop: 2001 }), // invalid
      ],
      NO_SPREAD,
    );

    expect(summary.totalPips).toBeCloseTo(400, 9);
    expect(summary.totalR).toBeCloseTo(2, 9);
    // Denominator is the two positions that produced a result.
    expect(summary.avgPips).toBeCloseTo(200, 9);
    expect(summary.expectancyR).toBeCloseTo(1, 9);
  });

  it('returns a zeroed summary with no NaN for empty input', () => {
    const { trades, summary } = evaluateManualPositions(EMPTY_M1, [], NO_SPREAD);

    expect(trades).toEqual([]);
    expect(summary).toEqual({
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
    });
    for (const v of Object.values(summary)) {
      expect(Number.isNaN(v)).toBe(false);
    }
  });

  it('does not mutate the caller’s positions array', () => {
    const m1 = makeM1(baseRows());
    const positions = [position()];
    const snapshot = JSON.parse(JSON.stringify(positions)) as unknown;
    evaluateManualPositions(m1, positions, NO_SPREAD);
    expect(JSON.parse(JSON.stringify(positions))).toEqual(snapshot);
  });
});

/* ---------- Replay cutoff (`until`) ---------- */

describe('evaluateManualPositions — replay cutoff', () => {
  /** Ten quiet minutes at 2000 with the target taken on minute 3. */
  function winM1() {
    const rows = baseRows();
    rows[3] = [T0 + 3 * MIN, 2000, 2004.5, 1999.5, 2004.2];
    return makeM1(rows);
  }

  it('reports a position the replay has not reached yet as open', () => {
    const m1 = winM1();
    const p = position({ time: T0 + 4 * MIN, endTime: T0 + 9 * MIN });

    const t = evaluateManualPositions(m1, [p], {
      includeSpread: false,
      until: T0 + 2 * MIN,
    }).trades[0];

    expect(t.outcome).toBe('open');
    expect(t.entryTime).toBeUndefined();
    expect(t.exitTime).toBeUndefined();
    expect(t.exitPrice).toBeUndefined();
    expect(t.pips).toBeUndefined();
    expect(t.r).toBeUndefined();
    // The planned geometry is still known — it was drawn, not measured.
    expect(t.plannedRR).toBeCloseTo(2, 9);
  });

  it('reports a filled but unresolved position as open, with its fill time', () => {
    const t = evaluateManualPositions(winM1(), [position()], {
      includeSpread: false,
      until: T0 + 1 * MIN,
    }).trades[0];

    expect(t.outcome).toBe('open');
    expect(t.entryTime).toBe(T0);
    expect(t.exitTime).toBeUndefined();
    expect(t.pips).toBeUndefined();
    expect(t.r).toBeUndefined();
    expect(t.minutesHeld).toBeUndefined();
  });

  it('resolves on the cutoff minute itself — the bound is inclusive', () => {
    const t = evaluateManualPositions(winM1(), [position()], {
      includeSpread: false,
      until: T0 + 3 * MIN,
    }).trades[0];

    expect(t.outcome).toBe('win');
    expect(t.exitTime).toBe(T0 + 3 * MIN);
    expect(t.r).toBeCloseTo(2, 9);
  });

  it('is still open one minute before the resolving minute', () => {
    const t = evaluateManualPositions(winM1(), [position()], {
      includeSpread: false,
      until: T0 + 2 * MIN,
    }).trades[0];

    expect(t.outcome).toBe('open');
  });

  it('never scans past the cutoff, even when the stop comes later', () => {
    const rows = baseRows();
    rows[6] = [T0 + 6 * MIN, 2000, 2000.5, 1997.5, 1997.8]; // stop, after the cutoff
    const t = evaluateManualPositions(makeM1(rows), [position()], {
      includeSpread: false,
      until: T0 + 5 * MIN,
    }).trades[0];

    expect(t.outcome).toBe('open');
    expect(t.entryTime).toBe(T0);
  });

  it('gives a byte-identical result once the cutoff is at or past endTime', () => {
    const m1 = winM1();
    const p = position();
    const uncut = evaluateManualPositions(m1, [p], NO_SPREAD);

    // Exactly on the deadline, and far past it.
    for (const until of [p.endTime, p.endTime + 500 * MIN]) {
      expect(
        evaluateManualPositions(m1, [p], { includeSpread: false, until }),
      ).toEqual(uncut);
    }
  });

  it('keeps an expired verdict identical under a cutoff past the end of DATA', () => {
    const rows = baseRows();
    rows[9] = quiet(9, 2000, 2001);
    const m1 = makeM1(rows);
    const p = position({ endTime: T0 + 5 * MIN });

    const uncut = evaluateManualPositions(m1, [p], NO_SPREAD);
    expect(uncut.trades[0].outcome).toBe('expired');
    // The last bar is bar 9; a cutoff at or past it hides nothing.
    for (const until of [T0 + 9 * MIN, T0 + 900 * MIN]) {
      expect(
        evaluateManualPositions(m1, [p], { includeSpread: false, until }),
      ).toEqual(uncut);
    }
  });

  it('will NOT resolve past the cutoff even when the cutoff is past the box', () => {
    // The regression this guards: the exit scan now runs past `endTime`, so a
    // cutoff beyond the box still has to hide the bars after it. Discarding it
    // there would resolve the trade on minutes the replay has not reached.
    const rows = baseRows();
    rows[7] = [T0 + 7 * MIN, 2000, 2004.5, 1999.5, 2004.2]; // target, past endTime
    const m1 = makeM1(rows);
    const p = position({ endTime: T0 + 5 * MIN });

    expect(evaluateManualPositions(m1, [p], NO_SPREAD).trades[0].outcome).toBe('win');

    // Replay is past the box but short of the target bar: still unknown.
    const t = evaluateManualPositions(m1, [p], {
      includeSpread: false,
      until: T0 + 6 * MIN,
    }).trades[0];
    expect(t.outcome).toBe('open');
    expect(t.pips).toBeUndefined();
  });

  it('holds back never_triggered until the whole window has been seen', () => {
    const rows = baseRows().map(
      (r, i) => [T0 + i * MIN, 2010, 2011, 2009, 2010] as Row,
    );
    const m1 = makeM1(rows);
    const p = position();

    const open = evaluateManualPositions(m1, [p], {
      includeSpread: false,
      until: T0 + 4 * MIN,
    }).trades[0];
    expect(open.outcome).toBe('open');
    expect(open.entryTime).toBeUndefined();

    // The same position, whole window seen: the verdict is final.
    expect(evaluateManualPositions(m1, [p], NO_SPREAD).trades[0].outcome).toBe(
      'never_triggered',
    );
  });

  it('reports a window with no minute data yet as open, not never_triggered', () => {
    const m1 = makeM1(baseRows());
    // Window starts after the loaded series ends, cutoff inside it.
    const p = position({ time: T0 + 20 * MIN, endTime: T0 + 30 * MIN });

    const t = evaluateManualPositions(m1, [p], {
      includeSpread: false,
      until: T0 + 25 * MIN,
    }).trades[0];

    expect(t.outcome).toBe('open');
  });

  it('still decides invalid geometry immediately under a cutoff', () => {
    const m1 = winM1();
    const t = evaluateManualPositions(m1, [position({ stop: 2001 })], {
      includeSpread: false,
      until: T0 - 100 * MIN,
    }).trades[0];

    expect(t.outcome).toBe('invalid');
    expect(t.reason).toMatch(/stop is above entry on a long/i);
  });

  it('applies the cutoff to a short the same way', () => {
    const rows = baseRows();
    rows[4] = [T0 + 4 * MIN, 2000, 2000.5, 1995.5, 1995.8]; // short target
    const m1 = makeM1(rows);
    const short = position({ side: 'short', stop: 2002, target: 1996 });

    const stillOpen = evaluateManualPositions(m1, [short], {
      includeSpread: false,
      until: T0 + 3 * MIN,
    }).trades[0];
    expect(stillOpen.outcome).toBe('open');
    expect(stillOpen.entryTime).toBe(T0);

    const won = evaluateManualPositions(m1, [short], {
      includeSpread: false,
      until: T0 + 4 * MIN,
    }).trades[0];
    expect(won.outcome).toBe('win');
    expect(won.r).toBeCloseTo(2, 9);
  });

  it('leaves open positions out of the win rate and the totals', () => {
    const m1 = winM1();
    const { summary } = evaluateManualPositions(
      m1,
      [
        position(), // fills at T0, target at T0+3m — resolved by the cutoff
        position({ time: T0 + 5 * MIN, endTime: T0 + 9 * MIN }), // not started yet
      ],
      { includeSpread: false, until: T0 + 3 * MIN },
    );

    expect(summary.total).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.open).toBe(1);
    expect(summary.evaluated).toBe(1);
    expect(summary.winRate).toBe(100);
    // Only the decided trade contributes P&L.
    expect(summary.totalPips).toBeCloseTo(400, 9);
    expect(summary.avgPips).toBeCloseTo(400, 9);
    expect(summary.totalR).toBeCloseTo(2, 9);
    expect(summary.expectancyR).toBeCloseTo(2, 9);
  });

  it('summarises an all-open set as zeroes, with no NaN', () => {
    const m1 = winM1();
    const { summary } = evaluateManualPositions(
      m1,
      [position(), position({ side: 'short', stop: 2002, target: 1996 })],
      { includeSpread: false, until: T0 + 1 * MIN },
    );

    expect(summary.total).toBe(2);
    expect(summary.open).toBe(2);
    expect(summary.evaluated).toBe(0);
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(0);
    expect(summary.winRate).toBe(0);
    expect(summary.totalPips).toBe(0);
    expect(summary.avgPips).toBe(0);
    expect(summary.totalR).toBe(0);
    expect(summary.expectancyR).toBe(0);
    for (const v of Object.values(summary)) {
      expect(Number.isNaN(v)).toBe(false);
    }
  });

  it('reports no open positions when no cutoff is given', () => {
    const { summary } = evaluateManualPositions(winM1(), [position()], NO_SPREAD);
    expect(summary.open).toBe(0);
  });
});
