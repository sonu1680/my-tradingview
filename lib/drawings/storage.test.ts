import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_STYLE,
  DRAWINGS_SCHEMA_VERSION,
  type Drawing,
  type HLineDrawing,
  type PositionDrawing,
  type TrendlineDrawing,
  type VLineDrawing,
} from '@/lib/drawings/types';

import {
  clearDrawings,
  isValidDrawing,
  loadDrawings,
  saveDrawings,
  storageKey,
} from '@/lib/drawings/storage';

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

/* ---------- fixtures ---------- */

const trendline: TrendlineDrawing = {
  id: 't1',
  kind: 'trendline',
  style: DEFAULT_STYLE,
  createdAt: 1700000000000,
  a: { time: 1000, price: 100 },
  b: { time: 2000, price: 110 },
};

const hline: HLineDrawing = {
  id: 'h1',
  kind: 'hline',
  style: DEFAULT_STYLE,
  createdAt: 1700000000001,
  price: 2345.67,
};

const vline: VLineDrawing = {
  id: 'v1',
  kind: 'vline',
  style: DEFAULT_STYLE,
  createdAt: 1700000000003,
  time: 1789344000,
};

const position: PositionDrawing = {
  id: 'p1',
  kind: 'position',
  style: DEFAULT_STYLE,
  createdAt: 1700000000002,
  side: 'long',
  time: 1000,
  endTime: 2000,
  entry: 100,
  stop: 90,
  target: 120,
  lots: 0.01,
};

const write = (symbol: string, payload: unknown): void => {
  store.map.set(storageKey(symbol), JSON.stringify(payload));
};

/* ---------- storageKey ---------- */

describe('storageKey', () => {
  it('includes the symbol and the schema version', () => {
    const k = storageKey('XAUUSD');
    expect(k).toContain('XAUUSD');
    expect(k).toContain(String(DRAWINGS_SCHEMA_VERSION));
  });

  it('is distinct per symbol', () => {
    expect(storageKey('XAUUSD')).not.toBe(storageKey('EURUSD'));
  });
});

/* ---------- isValidDrawing ---------- */

describe('isValidDrawing', () => {
  it('accepts every well-formed kind', () => {
    expect(isValidDrawing(trendline)).toBe(true);
    expect(isValidDrawing(hline)).toBe(true);
    expect(isValidDrawing(position)).toBe(true);
    expect(isValidDrawing({ ...trendline, kind: 'rect' })).toBe(true);
    expect(isValidDrawing({ ...trendline, kind: 'fib' })).toBe(true);
  });

  it('rejects junk', () => {
    const junk: unknown[] = [
      null,
      undefined,
      0,
      '',
      'trendline',
      [],
      {},
      { kind: 'trendline' },
      { ...trendline, kind: 'wormhole' },
      { ...trendline, id: undefined },
      { ...trendline, id: 42 },
      { ...trendline, createdAt: 'yesterday' },
      { ...trendline, style: null },
      { ...trendline, style: { color: 1, width: 2 } },
      { ...trendline, style: { color: '#fff' } },
      { ...trendline, a: { time: 1 } },
      { ...trendline, a: { time: NaN, price: 1 } },
      { ...trendline, b: null },
      { ...hline, price: Infinity },
      { ...hline, price: '100' },
      { ...position, side: 'sideways' },
      { ...position, lots: NaN },
      { ...position, entry: null },
      { ...position, endTime: undefined },
    ];
    for (const value of junk) {
      expect(isValidDrawing(value), JSON.stringify(value) ?? 'undefined').toBe(false);
    }
  });

  it('accepts a vline with a finite numeric time', () => {
    expect(isValidDrawing(vline)).toBe(true);
    expect(isValidDrawing({ ...vline, time: 0 })).toBe(true);
    expect(isValidDrawing({ ...vline, time: -1 })).toBe(true);
  });

  it('rejects a vline whose time is missing or not a finite number', () => {
    // Without this, the unknown-kind default would silently drop every saved
    // vertical line on the next load.
    const bad: unknown[] = [
      { id: 'v2', kind: 'vline', style: DEFAULT_STYLE, createdAt: 1 },
      { ...vline, time: undefined },
      { ...vline, time: null },
      { ...vline, time: NaN },
      { ...vline, time: Infinity },
      { ...vline, time: -Infinity },
      { ...vline, time: '1789344000' },
      { ...vline, time: { time: 1789344000 } },
    ];
    for (const value of bad) {
      expect(isValidDrawing(value), JSON.stringify(value) ?? 'undefined').toBe(false);
    }
  });

  it('still requires the base fields on a vline', () => {
    expect(isValidDrawing({ ...vline, id: '' })).toBe(false);
    expect(isValidDrawing({ ...vline, createdAt: NaN })).toBe(false);
    expect(isValidDrawing({ ...vline, style: undefined })).toBe(false);
  });
});

/* ---------- round trip ---------- */

describe('save / load round trip', () => {
  it('round-trips drawings', () => {
    const drawings: Drawing[] = [trendline, hline, position];
    saveDrawings('XAUUSD', drawings);
    expect(loadDrawings('XAUUSD')).toEqual(drawings);
  });

  it('round-trips a vline alongside the other kinds', () => {
    const drawings: Drawing[] = [trendline, hline, vline, position];
    saveDrawings('XAUUSD', drawings);
    expect(loadDrawings('XAUUSD')).toEqual(drawings);
  });

  it('keeps symbols separate', () => {
    saveDrawings('XAUUSD', [trendline]);
    saveDrawings('EURUSD', [hline]);
    expect(loadDrawings('XAUUSD')).toEqual([trendline]);
    expect(loadDrawings('EURUSD')).toEqual([hline]);
  });

  it('returns [] when nothing is stored', () => {
    expect(loadDrawings('NOPE')).toEqual([]);
  });

  it('clears one symbol only', () => {
    saveDrawings('XAUUSD', [trendline]);
    saveDrawings('EURUSD', [hline]);
    clearDrawings('XAUUSD');
    expect(loadDrawings('XAUUSD')).toEqual([]);
    expect(loadDrawings('EURUSD')).toEqual([hline]);
  });

  it('saving an empty array clears the drawings', () => {
    saveDrawings('XAUUSD', [trendline]);
    saveDrawings('XAUUSD', []);
    expect(loadDrawings('XAUUSD')).toEqual([]);
  });
});

/* ---------- defensive parsing ---------- */

describe('loadDrawings is defensive', () => {
  it('returns [] for corrupt JSON', () => {
    store.map.set(storageKey('XAUUSD'), '{not json at all');
    expect(loadDrawings('XAUUSD')).toEqual([]);
  });

  it('returns [] for a wrong schema version', () => {
    write('XAUUSD', {
      version: DRAWINGS_SCHEMA_VERSION + 1,
      symbol: 'XAUUSD',
      drawings: [trendline],
    });
    expect(loadDrawings('XAUUSD')).toEqual([]);
  });

  it('returns [] for a missing version', () => {
    write('XAUUSD', { symbol: 'XAUUSD', drawings: [trendline] });
    expect(loadDrawings('XAUUSD')).toEqual([]);
  });

  it('returns [] when the payload is not an object', () => {
    for (const payload of [null, 3, 'hello', true]) {
      write('XAUUSD', payload);
      expect(loadDrawings('XAUUSD')).toEqual([]);
    }
  });

  it('returns [] when drawings is not an array', () => {
    write('XAUUSD', {
      version: DRAWINGS_SCHEMA_VERSION,
      symbol: 'XAUUSD',
      drawings: { nope: true },
    });
    expect(loadDrawings('XAUUSD')).toEqual([]);
  });

  it('drops individual bad drawings and keeps the good ones', () => {
    write('XAUUSD', {
      version: DRAWINGS_SCHEMA_VERSION,
      symbol: 'XAUUSD',
      drawings: [
        trendline,
        { kind: 'wormhole', id: 'w' },
        null,
        { ...hline, price: 'NaN' },
        hline,
        { ...position, lots: null },
        position,
      ],
    });
    expect(loadDrawings('XAUUSD')).toEqual([trendline, hline, position]);
  });

  it('drops a vline with a non-finite time and keeps its valid sibling', () => {
    // JSON.stringify turns NaN into null on the way in; either way it is not
    // a finite number and must not come back as a drawing.
    write('XAUUSD', {
      version: DRAWINGS_SCHEMA_VERSION,
      symbol: 'XAUUSD',
      drawings: [{ ...vline, id: 'v-bad', time: NaN }, vline, { ...vline, id: 'v-str', time: 'soon' }],
    });
    expect(loadDrawings('XAUUSD')).toEqual([vline]);
  });
});

/* ---------- failure isolation ---------- */

describe('storage failures never propagate', () => {
  it('loadDrawings returns [] when getItem throws', () => {
    install(makeStorage({ throwOnGet: true }));
    expect(() => loadDrawings('XAUUSD')).not.toThrow();
    expect(loadDrawings('XAUUSD')).toEqual([]);
  });

  it('saveDrawings swallows a quota error', () => {
    install(makeStorage({ throwOnSet: true }));
    expect(() => saveDrawings('XAUUSD', [trendline])).not.toThrow();
  });

  it('clearDrawings swallows a removeItem error', () => {
    install(makeStorage({ throwOnSet: true }));
    expect(() => clearDrawings('XAUUSD')).not.toThrow();
  });

  it('warns at most once across many failing calls', () => {
    install(makeStorage({ throwOnSet: true }));
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    for (let i = 0; i < 5; i += 1) saveDrawings('XAUUSD', [trendline]);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('is a no-op on the server, where window is undefined', () => {
    install(undefined);
    expect(loadDrawings('XAUUSD')).toEqual([]);
    expect(() => saveDrawings('XAUUSD', [trendline])).not.toThrow();
    expect(() => clearDrawings('XAUUSD')).not.toThrow();
    expect(() => storageKey('XAUUSD')).not.toThrow();
  });
});
