import { describe, expect, it } from 'vitest';
import type { Bar } from '@/lib/candles/types';
import {
  CATALOG_GROUPS,
  INDICATOR_DEFS,
  INDICATOR_IDS,
  colorOf,
  computeInstance,
  createInstance,
  indicatorDef,
  instanceLabel,
  isIndicatorId,
  paramOf,
  sourceValues,
  toColumns,
  type IndicatorId,
} from './catalog';

function makeBars(count: number): Bar[] {
  const bars: Bar[] = [];
  let price = 2000;
  for (let i = 0; i < count; i += 1) {
    price += Math.sin(i / 5) * 4 + Math.cos(i / 13) * 2;
    bars.push({
      time: 1_700_000_000 + i * 900,
      open: price - 0.5,
      high: price + 1.5,
      low: price - 1.5,
      close: price,
      volume: 100 + (i % 17) * 10,
    });
  }
  return bars;
}

describe('toColumns / sourceValues', () => {
  it('transposes bars into columns without losing a value', () => {
    const bars = makeBars(5);
    const columns = toColumns(bars);
    expect(columns.length).toBe(5);
    expect(Array.from(columns.close)).toEqual(bars.map((b) => b.close));
    expect(Array.from(columns.volume)).toEqual(bars.map((b) => b.volume));
  });

  it('derives the composite sources', () => {
    const columns = toColumns([
      { time: 0, open: 10, high: 20, low: 0, close: 14, volume: 1 },
    ]);
    expect(sourceValues(columns, 'hl2')[0]).toBe(10);
    expect(sourceValues(columns, 'hlc3')[0]).toBeCloseTo(34 / 3, 12);
    expect(sourceValues(columns, 'ohlc4')[0]).toBe(11);
    expect(sourceValues(columns, 'close')[0]).toBe(14);
  });
});

describe('the catalog itself', () => {
  it('lists every id exactly once across the picker groups', () => {
    const grouped = CATALOG_GROUPS.flatMap((group) => group.ids);
    expect([...grouped].sort()).toEqual([...INDICATOR_IDS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('keeps each definition self-consistent', () => {
    for (const id of INDICATOR_IDS) {
      const def = indicatorDef(id);
      expect(def.id, `${id} must be keyed by its own id`).toBe(id);
      expect(def.plots.length, `${id} must draw something`).toBeGreaterThan(0);
      expect(new Set(def.plots.map((p) => p.key)).size).toBe(def.plots.length);
      expect(new Set(def.inputs.map((i) => i.key)).size).toBe(def.inputs.length);
      for (const input of def.inputs) {
        expect(input.fallback).toBeGreaterThanOrEqual(input.min);
        expect(input.fallback).toBeLessThanOrEqual(input.max);
      }
      // An oscillator on the price pane would flatten the candles.
      if (def.fixedRange !== undefined) expect(def.pane).toBe('separate');
    }
  });

  it('recognises only real ids', () => {
    expect(isIndicatorId('rsi')).toBe(true);
    expect(isIndicatorId('ichimoku')).toBe(false);
  });
});

describe('paramOf', () => {
  const def = INDICATOR_DEFS.ema;

  it('falls back to the definition default when the value is missing or unusable', () => {
    expect(paramOf(def, {}, 'length')).toBe(21);
    expect(paramOf(def, { length: NaN }, 'length')).toBe(21);
    expect(paramOf(def, { length: Infinity }, 'length')).toBe(21);
  });

  it('clamps rather than rejecting an out-of-range stored value', () => {
    expect(paramOf(def, { length: -4 }, 'length')).toBe(1);
    expect(paramOf(def, { length: 99_999 }, 'length')).toBe(1000);
    expect(paramOf(def, { length: 55 }, 'length')).toBe(55);
  });
});

describe('createInstance', () => {
  it('seeds params and colours from the definition', () => {
    const instance = createInstance('bb');
    expect(instance.params).toEqual({ length: 20, multiplier: 2 });
    expect(Object.keys(instance.colors).sort()).toEqual(['lower', 'middle', 'upper']);
    expect(instance.visible).toBe(true);
  });

  it('gives every instance a distinct id so three EMAs can coexist', () => {
    const ids = [createInstance('ema'), createInstance('ema'), createInstance('ema')]
      .map((instance) => instance.instanceId);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('instanceLabel', () => {
  it('prints the parameters a trader needs to tell two copies apart', () => {
    const ema = createInstance('ema');
    expect(instanceLabel(ema)).toBe('EMA 21');
    expect(instanceLabel({ ...ema, params: { length: 200 } })).toBe('EMA 200');
    expect(instanceLabel(createInstance('macd'))).toBe('MACD 12 26 9');
    expect(instanceLabel(createInstance('vwap'))).toBe('VWAP');
  });

  it('does not print a trailing .0 on a whole-number decimal input', () => {
    expect(instanceLabel(createInstance('bb'))).toBe('BB 20 2');
    const wide = { ...createInstance('bb'), params: { length: 20, multiplier: 2.5 } };
    expect(instanceLabel(wide)).toBe('BB 20 2.5');
  });
});

describe('colorOf', () => {
  it('uses the instance colour, falling back to the definition', () => {
    const instance = createInstance('ema');
    const plot = INDICATOR_DEFS.ema.plots[0];
    expect(colorOf(instance, plot)).toBe(instance.colors.ema);
    expect(colorOf({ ...instance, colors: {} }, plot)).toBe(plot.color);
    expect(colorOf({ ...instance, colors: { ema: '' } }, plot)).toBe(plot.color);
  });
});

describe('computeInstance', () => {
  const bars = makeBars(400);
  const columns = toColumns(bars);

  it('produces a column for every declared plot of every indicator', () => {
    for (const id of INDICATOR_IDS) {
      const def = indicatorDef(id);
      const result = computeInstance(createInstance(id), columns);
      for (const plot of def.plots) {
        const series = result[plot.key];
        expect(series, `${id}.${plot.key} must be computed`).toBeInstanceOf(Float64Array);
        expect(series.length, `${id}.${plot.key} length`).toBe(bars.length);
      }
    }
  });

  it('produces at least one finite value per plot on 400 bars', () => {
    for (const id of INDICATOR_IDS) {
      const def = indicatorDef(id);
      const result = computeInstance(createInstance(id), columns);
      for (const plot of def.plots) {
        const finite = Array.from(result[plot.key]).some((v) => Number.isFinite(v));
        expect(finite, `${id}.${plot.key} is entirely NaN on 400 bars`).toBe(true);
      }
    }
  });

  it('returns no values rather than throwing when the page is too short', () => {
    const tiny = toColumns(makeBars(5));
    for (const id of INDICATOR_IDS) {
      expect(() => computeInstance(createInstance(id), tiny)).not.toThrow();
    }
    // A 200-period SMA on 5 bars is a legitimate request with no answer yet.
    const long = { ...createInstance('sma'), params: { length: 200 } };
    const result = computeInstance(long, tiny);
    expect(Array.from(result.sma).every((v) => Number.isNaN(v))).toBe(true);
  });

  it('returns an empty record on an empty page', () => {
    expect(computeInstance(createInstance('rsi'), toColumns([]))).toEqual({});
  });

  it('honours the chosen source on indicators that have one', () => {
    const onClose = computeInstance(createInstance('sma'), columns).sma;
    const onHigh = computeInstance(
      { ...createInstance('sma'), source: 'high' },
      columns,
    ).sma;
    expect(onHigh[300]).toBeGreaterThan(onClose[300]);
  });

  it('ignores the stored source on indicators that do not take one', () => {
    // ATR is built from the bar range; a stale `source: 'open'` from an older
    // layout must not change its output.
    const plain = computeInstance(createInstance('atr'), columns).atr;
    const meddled = computeInstance(
      { ...createInstance('atr'), source: 'open' },
      columns,
    ).atr;
    expect(Array.from(meddled)).toEqual(Array.from(plain));
  });

  it('keeps oscillators inside their declared fixed range', () => {
    for (const id of INDICATOR_IDS) {
      const def = indicatorDef(id);
      if (def.fixedRange === undefined) continue;
      const result = computeInstance(createInstance(id as IndicatorId), columns);
      for (const plot of def.plots) {
        for (const value of result[plot.key]) {
          if (!Number.isFinite(value)) continue;
          expect(value, `${id}.${plot.key} out of range`).toBeGreaterThanOrEqual(
            def.fixedRange.min,
          );
          expect(value).toBeLessThanOrEqual(def.fixedRange.max);
        }
      }
    }
  });
});
