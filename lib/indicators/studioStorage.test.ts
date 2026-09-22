import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_INDICATORS, createInstance, type IndicatorInstance } from './catalog';
import {
  STUDIO_SCHEMA_VERSION,
  clearStudio,
  isValidInstance,
  loadStudio,
  saveStudio,
  studioKey,
} from './studioStorage';

/* ---------- a stubbable localStorage ---------- */

interface FakeStorage extends Storage {
  map: Map<string, string>;
}

function makeStorage(opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}): FakeStorage {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => {
      if (opts.throwOnGet) throw new DOMException('SecurityError');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new DOMException('QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k: string) => {
      if (opts.throwOnSet) throw new DOMException('SecurityError');
      map.delete(k);
    },
  };
}

type Globals = { window?: unknown; localStorage?: Storage };

function install(store: Storage | undefined): void {
  const g = globalThis as Globals;
  if (store === undefined) {
    delete g.window;
    delete g.localStorage;
    return;
  }
  g.window = { localStorage: store };
  g.localStorage = store;
}

const SYMBOL = 'XAUUSDm';
let store: FakeStorage;

beforeEach(() => {
  store = makeStorage();
  install(store);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  install(undefined);
  vi.restoreAllMocks();
});

function write(value: unknown): void {
  store.map.set(studioKey(SYMBOL), JSON.stringify(value));
}

describe('round trip', () => {
  it('restores what was saved', () => {
    const instances = [createInstance('ema'), createInstance('rsi')];
    saveStudio(SYMBOL, instances);
    const loaded = loadStudio(SYMBOL);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe('ema');
    expect(loaded[0].instanceId).toBe(instances[0].instanceId);
    expect(loaded[1].params.length).toBe(14);
  });

  it('starts empty when nothing was ever saved', () => {
    expect(loadStudio(SYMBOL)).toEqual([]);
  });

  it('keeps layouts for different symbols apart', () => {
    saveStudio(SYMBOL, [createInstance('ema')]);
    expect(loadStudio('EURUSD')).toEqual([]);
  });

  it('clears', () => {
    saveStudio(SYMBOL, [createInstance('ema')]);
    clearStudio(SYMBOL);
    expect(loadStudio(SYMBOL)).toEqual([]);
  });
});

describe('defensive loading', () => {
  it('returns empty on corrupt JSON instead of throwing', () => {
    store.map.set(studioKey(SYMBOL), '{not json');
    expect(loadStudio(SYMBOL)).toEqual([]);
  });

  it('ignores a file from a different schema version', () => {
    write({ version: STUDIO_SCHEMA_VERSION + 1, savedAt: 0, instances: [createInstance('ema')] });
    expect(loadStudio(SYMBOL)).toEqual([]);
  });

  it('ignores a file whose instances are not an array', () => {
    write({ version: STUDIO_SCHEMA_VERSION, savedAt: 0, instances: { id: 'ema' } });
    expect(loadStudio(SYMBOL)).toEqual([]);
  });

  it('drops one bad instance while keeping its good siblings', () => {
    const good = createInstance('ema');
    const alsoGood = createInstance('rsi');
    write({
      version: STUDIO_SCHEMA_VERSION,
      savedAt: 0,
      instances: [good, { ...alsoGood, id: 'ichimoku' }, alsoGood],
    });
    const loaded = loadStudio(SYMBOL);
    expect(loaded.map((i) => i.id)).toEqual(['ema', 'rsi']);
  });

  it('drops a duplicate instanceId, which would collide as a chart series key', () => {
    const one = createInstance('ema');
    write({ version: STUDIO_SCHEMA_VERSION, savedAt: 0, instances: [one, { ...one }] });
    expect(loadStudio(SYMBOL)).toHaveLength(1);
  });

  it('caps the layout at MAX_INDICATORS', () => {
    const many = Array.from({ length: MAX_INDICATORS + 6 }, () => createInstance('ema'));
    write({ version: STUDIO_SCHEMA_VERSION, savedAt: 0, instances: many });
    expect(loadStudio(SYMBOL)).toHaveLength(MAX_INDICATORS);
  });

  it('survives a throwing getItem', () => {
    install(makeStorage({ throwOnGet: true }));
    expect(loadStudio(SYMBOL)).toEqual([]);
  });

  it('survives a quota-exceeded setItem', () => {
    install(makeStorage({ throwOnSet: true }));
    expect(() => saveStudio(SYMBOL, [createInstance('ema')])).not.toThrow();
    expect(() => clearStudio(SYMBOL)).not.toThrow();
  });

  it('is a no-op with no window at all (server rendering)', () => {
    install(undefined);
    expect(loadStudio(SYMBOL)).toEqual([]);
    expect(() => saveStudio(SYMBOL, [createInstance('ema')])).not.toThrow();
  });
});

describe('hydration of older layouts', () => {
  it('fills in an input the stored instance predates', () => {
    const bb = createInstance('bb');
    // An older build that only had `length`.
    write({
      version: STUDIO_SCHEMA_VERSION,
      savedAt: 0,
      instances: [{ ...bb, params: { length: 34 } }],
    });
    const [loaded] = loadStudio(SYMBOL);
    expect(loaded.params.length).toBe(34);
    expect(loaded.params.multiplier).toBe(2);
  });

  it('fills in a plot colour the stored instance predates', () => {
    const macd = createInstance('macd');
    write({
      version: STUDIO_SCHEMA_VERSION,
      savedAt: 0,
      instances: [{ ...macd, colors: { macd: '#ffffff' } }],
    });
    const [loaded] = loadStudio(SYMBOL);
    expect(loaded.colors.macd).toBe('#ffffff');
    expect(loaded.colors.signal).toBeDefined();
    expect(loaded.colors.histogram).toBeDefined();
  });

  it('resets a meaningless stored source on a sourceless indicator', () => {
    const atr = createInstance('atr');
    write({
      version: STUDIO_SCHEMA_VERSION,
      savedAt: 0,
      instances: [{ ...atr, source: 'open' }],
    });
    expect(loadStudio(SYMBOL)[0].source).toBe('close');
  });

  it('tolerates a param key this build no longer has', () => {
    const ema = createInstance('ema');
    write({
      version: STUDIO_SCHEMA_VERSION,
      savedAt: 0,
      instances: [{ ...ema, params: { length: 9, offset: 3 } }],
    });
    const [loaded] = loadStudio(SYMBOL);
    expect(loaded.params.length).toBe(9);
  });
});

describe('isValidInstance', () => {
  const base = createInstance('ema');
  const reject = (patch: Partial<Record<keyof IndicatorInstance, unknown>>) =>
    expect(isValidInstance({ ...base, ...patch })).toBe(false);

  it('accepts a freshly created instance', () => {
    expect(isValidInstance(base)).toBe(true);
  });

  it('rejects the things that would break the chart', () => {
    reject({ instanceId: '' });
    reject({ id: 'nope' });
    reject({ visible: 'yes' });
    reject({ lineWidth: 0 });
    reject({ lineWidth: 99 });
    reject({ lineWidth: NaN });
    reject({ source: 'vwap' });
    reject({ params: [] });
    reject({ params: { length: 'ten' } });
    reject({ params: { length: NaN } });
    reject({ colors: { ema: 'drop table' } });
    expect(isValidInstance(null)).toBe(false);
    expect(isValidInstance([base])).toBe(false);
  });

  it('accepts hex and rgba colours', () => {
    expect(isValidInstance({ ...base, colors: { ema: '#fff' } })).toBe(true);
    expect(isValidInstance({ ...base, colors: { ema: 'rgba(1, 2, 3, 0.5)' } })).toBe(true);
  });
});
