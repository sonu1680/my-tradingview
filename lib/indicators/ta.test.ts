import { describe, expect, it } from 'vitest';
import {
  adx,
  atr,
  bollinger,
  ema,
  hma,
  macd,
  rma,
  rsi,
  sma,
  stdev,
  stochastic,
  supertrend,
  trueRange,
  vwap,
  wma,
} from './ta';

/** Every function marks its warm-up with NaN; this asserts that, not `0`. */
function expectWarmup(out: Float64Array, upToExclusive: number): void {
  for (let i = 0; i < upToExclusive; i += 1) {
    expect(Number.isNaN(out[i]), `index ${i} should be NaN, got ${out[i]}`).toBe(true);
  }
}

describe('sma', () => {
  it('averages the window and leaves the warm-up undefined', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expectWarmup(out, 2);
    expect(Array.from(out.subarray(2))).toEqual([2, 3, 4]);
  });

  it('matches a naive O(n*p) recomputation over a long noisy series', () => {
    // The running-sum optimisation is where drift would hide.
    const values: number[] = [];
    let x = 1000;
    for (let i = 0; i < 500; i += 1) {
      x += Math.sin(i * 0.37) * 3 + Math.cos(i * 0.11) * 1.5;
      values.push(x);
    }
    const fast = sma(values, 20);
    for (let i = 19; i < values.length; i += 1) {
      let sum = 0;
      for (let j = i - 19; j <= i; j += 1) sum += values[j];
      expect(fast[i]).toBeCloseTo(sum / 20, 9);
    }
  });

  it('returns all-NaN when the series is shorter than the period', () => {
    expectWarmup(sma([1, 2], 5), 2);
  });
});

describe('stdev', () => {
  it('is the population deviation, not the sample deviation', () => {
    const out = stdev([1, 2, 3], 3);
    // Population: sqrt(2/3) = 0.8165. Sample would be 1.0.
    expect(out[2]).toBeCloseTo(Math.sqrt(2 / 3), 10);
    expect(out[2]).not.toBeCloseTo(1, 3);
  });

  it('is zero on a flat window', () => {
    expect(stdev([5, 5, 5, 5], 4)[3]).toBe(0);
  });
});

describe('ema', () => {
  it('seeds from the SMA of the first period values', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expectWarmup(out, 2);
    expect(out[2]).toBe(2);       // sma(1,2,3)
    expect(out[3]).toBe(3);       // 0.5*4 + 0.5*2
    expect(out[4]).toBe(4);       // 0.5*5 + 0.5*3
  });

  it('converges to a constant input', () => {
    const out = ema(new Array(200).fill(42), 20);
    expect(out[199]).toBeCloseTo(42, 10);
  });
});

describe('rma', () => {
  it("uses Wilder's 1/period smoothing, not 2/(period+1)", () => {
    const out = rma([1, 2, 3, 4, 5], 3);
    expect(out[2]).toBe(2);
    expect(out[3]).toBeCloseTo(8 / 3, 12);   // (4 + 2*2)/3
    expect(out[4]).toBeCloseTo(31 / 9, 12);  // (5 + 2*8/3)/3
    // An EMA of the same period would give 3 and 4 here.
    const asEma = ema([1, 2, 3, 4, 5], 3);
    expect(out[3]).not.toBeCloseTo(asEma[3], 6);
  });
});

describe('wma', () => {
  it('weights the newest bar most heavily', () => {
    // (3*3 + 2*2 + 1*1) / 6
    expect(wma([1, 2, 3], 3)[2]).toBeCloseTo(14 / 6, 12);
  });

  it('leads a simple average on a rising series', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(wma(values, 4)[7]).toBeGreaterThan(sma(values, 4)[7]);
  });
});

describe('hma', () => {
  it('cuts most of the lag of a same-period average, but not all of it', () => {
    // On a straight line the inner combination `2*wma(n/2) - wma(n)` lands
    // exactly back on the line; the outer `wma(sqrt(n))` then re-introduces a
    // known lag of slope*(sqrt(n)-1)/3 = 2*(3-1)/3 = 4/3. So 118 - 4/3.
    // Claims that the Hull average is lag-free are marketing, not algebra.
    const values = Array.from({ length: 60 }, (_, i) => i * 2);
    const out = hma(values, 9);
    expect(out[59]).toBeCloseTo(118 - 4 / 3, 9);

    // It is still far closer to price than an EMA of the same period.
    const slow = ema(values, 9);
    expect(118 - out[59]).toBeLessThan(118 - slow[59]);
  });

  it('is all NaN when the series is too short to smooth', () => {
    expectWarmup(hma([1, 2, 3], 16), 3);
  });
});

describe('rsi', () => {
  it("reproduces Wilder's published 14-period example", () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
    ];
    const out = rsi(closes, 14);
    expectWarmup(out, 14);
    // Hand-computed from Wilder's definition on exactly these closes:
    // sum(gain)=3.34, sum(loss)=1.40 over the first 14 changes, so
    // avgGain=0.2385714, avgLoss=0.1, RS=2.3857143, RSI=70.4639.
    // Tables that quote 70.53 for "this" series use unrounded source closes.
    expect(out[14]).toBeCloseTo(70.4639, 3);
    expect(out[15]).toBeCloseTo(66.2497, 3);
    expect(out[19]).toBeCloseTo(57.9150, 3);
  });

  it('prints 100 when nothing has gone down, and stays in range', () => {
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(rsi(rising, 14)[39]).toBe(100);

    const falling = Array.from({ length: 40 }, (_, i) => 100 - i);
    const low = rsi(falling, 14)[39];
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThan(1);
  });
});

describe('macd', () => {
  it('is fast EMA minus slow EMA, with the histogram closing the loop', () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 6) * 8);
    const out = macd(closes, 12, 26, 9);
    const fast = ema(closes, 12);
    const slow = ema(closes, 26);

    expect(out.macd[100]).toBeCloseTo(fast[100] - slow[100], 10);
    expect(out.histogram[100]).toBeCloseTo(out.macd[100] - out.signal[100], 10);
    // The MACD line cannot exist before the slow EMA does.
    expectWarmup(out.macd, 25);
    expect(Number.isFinite(out.macd[25])).toBe(true);
  });
});

describe('bollinger', () => {
  it('places the bands a multiple of the deviation off the basis', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 7));
    const out = bollinger(closes, 20, 2);
    const basis = sma(closes, 20);
    const deviation = stdev(closes, 20);
    expect(out.middle[50]).toBeCloseTo(basis[50], 10);
    expect(out.upper[50]).toBeCloseTo(basis[50] + 2 * deviation[50], 10);
    expect(out.lower[50]).toBeCloseTo(basis[50] - 2 * deviation[50], 10);
  });

  it('collapses onto the basis when price is flat', () => {
    const out = bollinger(new Array(40).fill(10), 20, 2);
    expect(out.upper[39]).toBe(10);
    expect(out.lower[39]).toBe(10);
  });
});

describe('trueRange / atr', () => {
  it('leaves bar 0 undefined rather than using its own range', () => {
    const tr = trueRange([10, 11], [9, 10], [9.5, 10.5]);
    expect(Number.isNaN(tr[0])).toBe(true);
    // max(11-10, |11-9.5|, |10-9.5|) = 1.5 — the gap, not the 1.0 body range.
    expect(tr[1]).toBeCloseTo(1.5, 12);
  });

  it('is the Wilder average of true range, offset by the missing first bar', () => {
    const high = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5 + 1);
    const low = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5 - 1);
    const close = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5);
    const out = atr(high, low, close, 14);
    const expected = rma(trueRange(high, low, close).subarray(1), 14);
    expect(out[40]).toBeCloseTo(expected[39], 10);
    expect(Number.isNaN(out[0])).toBe(true);
  });
});

describe('stochastic', () => {
  it('reads 100 at the top of the range and 0 at the bottom', () => {
    const high = [10, 11, 12, 13, 14];
    const low = [5, 6, 7, 8, 9];
    const atTop = stochastic(high, low, [0, 0, 0, 0, 14], 5, 1, 1);
    expect(atTop.k[4]).toBeCloseTo(100, 10);

    const atBottom = stochastic(high, low, [0, 0, 0, 0, 5], 5, 1, 1);
    expect(atBottom.k[4]).toBeCloseTo(0, 10);
  });

  it('returns the neutral 50 on a range-less window instead of dividing by zero', () => {
    const flat = new Array(10).fill(7);
    const out = stochastic(flat, flat, flat, 5, 3, 3);
    expect(out.k[9]).toBe(50);
    expect(Number.isFinite(out.d[9])).toBe(true);
  });
});

describe('adx', () => {
  it('separates direction into the DIs and keeps ADX direction-blind', () => {
    const n = 80;
    const up = {
      high: Array.from({ length: n }, (_, i) => 100 + i + 0.6),
      low: Array.from({ length: n }, (_, i) => 100 + i - 0.4),
      close: Array.from({ length: n }, (_, i) => 100 + i + 0.3),
    };
    const rising = adx(up.high, up.low, up.close, 14);
    expect(rising.plusDi[70]).toBeGreaterThan(rising.minusDi[70]);
    expect(rising.adx[70]).toBeGreaterThan(40);

    // Mirror the series: ADX must be about the same, the DIs must swap.
    const down = {
      high: up.high.map((_, i) => 100 - i + 0.6),
      low: up.low.map((_, i) => 100 - i - 0.4),
      close: up.close.map((_, i) => 100 - i + 0.3),
    };
    const falling = adx(down.high, down.low, down.close, 14);
    expect(falling.minusDi[70]).toBeGreaterThan(falling.plusDi[70]);
    expect(falling.adx[70]).toBeGreaterThan(40);
  });

  it('stays low in a choppy range', () => {
    const n = 120;
    const close = Array.from({ length: n }, (_, i) => 100 + (i % 2 === 0 ? 0.4 : -0.4));
    const high = close.map((c) => c + 0.5);
    const low = close.map((c) => c - 0.5);
    expect(adx(high, low, close, 14)['adx'][110]).toBeLessThan(30);
  });
});

describe('supertrend', () => {
  it('sits below price in an uptrend and flips on a decisive reversal', () => {
    const n = 90;
    const close: number[] = [];
    for (let i = 0; i < n; i += 1) close.push(i < 60 ? 100 + i : 160 - (i - 60) * 4);
    const high = close.map((c) => c + 1);
    const low = close.map((c) => c - 1);

    const out = supertrend(high, low, close, 10, 3);
    expect(out.direction[55]).toBe(1);
    expect(out.line[55]).toBeLessThan(close[55]);

    expect(out.direction[85]).toBe(-1);
    expect(out.line[85]).toBeGreaterThan(close[85]);
  });

  it('ratchets: the support band never falls while the uptrend holds', () => {
    const n = 80;
    const close = Array.from({ length: n }, (_, i) => 100 + i * 0.8);
    const high = close.map((c, i) => c + 1 + (i % 5));   // noisy ranges
    const low = close.map((c) => c - 1);
    const out = supertrend(high, low, close, 10, 2);

    for (let i = 30; i < n; i += 1) {
      if (out.direction[i] === 1 && out.direction[i - 1] === 1) {
        expect(out.line[i]).toBeGreaterThanOrEqual(out.line[i - 1] - 1e-9);
      }
    }
  });
});

describe('vwap', () => {
  const DAY = 86400;

  it('is the volume-weighted typical price within a session', () => {
    const time = [0, 60, 120];
    const high = [11, 13, 15];
    const low = [9, 11, 13];
    const close = [10, 12, 14];
    const volume = [100, 100, 200];
    const out = vwap(time, high, low, close, volume);

    expect(out[0]).toBeCloseTo(10, 12);
    expect(out[1]).toBeCloseTo((10 * 100 + 12 * 100) / 200, 12);
    expect(out[2]).toBeCloseTo((10 * 100 + 12 * 100 + 14 * 200) / 400, 12);
  });

  it('resets at the day boundary rather than carrying the session over', () => {
    const time = [0, 60, DAY, DAY + 60];
    const price = [10, 12, 100, 102];
    const out = vwap(time, price, price, price, [100, 100, 100, 100]);

    expect(out[1]).toBeCloseTo(11, 12);
    // A carried-over session would drag this toward 11.
    expect(out[2]).toBeCloseTo(100, 12);
    expect(out[3]).toBeCloseTo(101, 12);
  });

  it('ignores zero-volume bars instead of dragging the average to them', () => {
    const time = [0, 60, 120];
    const price = [10, 999, 10];
    const out = vwap(time, price, price, price, [100, 0, 100]);
    expect(out[2]).toBeCloseTo(10, 12);
  });
});
