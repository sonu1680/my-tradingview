import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COUNT_LOG_VERSION,
  MAX_COUNTED_TRADES,
  type CountLogFile,
  type CountedTrade,
} from '@/lib/counter/types';

import {
  clearCountLog,
  isValidCountedTrade,
  loadCountLog,
  saveCountLog,
  storageKey,
} from '@/lib/counter/storage';

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

const SYM = 'XAUUSDm';

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

function trade(id: string, over: Partial<CountedTrade> = {}): CountedTrade {
  return {
    id,
    loggedAt: 1_700_000_000,
    timeframe: 'M15',
    side: 'long',
    entry: 2000,
    stop: 1990,
    target: 2020,
    riskPips: 1000,
    rewardPips: 2000,
    plannedRR: 2,
    outcome: 'win',
    entryTime: 1_700_000_060,
    exitTime: 1_700_003_660,
    exitPrice: 2020,
    pips: 200,
    r: 2,
    minutesHeld: 60,
    ...over,
  };
}

function file(trades: CountedTrade[], enabled = true): CountLogFile {
  return { version: COUNT_LOG_VERSION, symbol: SYM, enabled, trades };
}

/* ---------- tests ---------- */

describe('isValidCountedTrade', () => {
  it('accepts a full trade and an open one with no result fields', () => {
    expect(isValidCountedTrade(trade('a'))).toBe(true);
    expect(
      isValidCountedTrade({
        id: 'b',
        loggedAt: 1,
        timeframe: 'H1',
        side: 'short',
        entry: 1,
        stop: 2,
        target: 0.5,
        riskPips: 100,
        rewardPips: 50,
        plannedRR: null,
        outcome: 'open',
      }),
    ).toBe(true);
  });

  it('rejects junk, missing fields, bad outcomes and NaN numbers', () => {
    expect(isValidCountedTrade(null)).toBe(false);
    expect(isValidCountedTrade([])).toBe(false);
    expect(isValidCountedTrade('nope')).toBe(false);
    expect(isValidCountedTrade({ ...trade('a'), id: '' })).toBe(false);
    expect(isValidCountedTrade({ ...trade('a'), side: 'sideways' })).toBe(false);
    expect(isValidCountedTrade({ ...trade('a'), outcome: 'pending' })).toBe(false);
    expect(isValidCountedTrade({ ...trade('a'), entry: Number.NaN })).toBe(false);
    expect(isValidCountedTrade({ ...trade('a'), plannedRR: 'two' })).toBe(false);
    expect(isValidCountedTrade({ ...trade('a'), pips: 'lots' })).toBe(false);
    const noLoggedAt: Record<string, unknown> = { ...trade('a') };
    delete noLoggedAt.loggedAt;
    expect(isValidCountedTrade(noLoggedAt)).toBe(false);
  });
});

describe('loadCountLog / saveCountLog', () => {
  it('round-trips the trades and the enabled flag', () => {
    const original = file([trade('a'), trade('b', { outcome: 'open', pips: undefined, r: undefined })]);
    saveCountLog(SYM, original);
    expect(loadCountLog(SYM)).toEqual(original);
  });

  it('writes under a versioned, symbol-scoped key', () => {
    saveCountLog(SYM, file([trade('a')]));
    expect(store.map.has(storageKey(SYM))).toBe(true);
    expect(storageKey(SYM)).toContain(`v${COUNT_LOG_VERSION}`);
    expect(storageKey(SYM)).toContain(SYM);
    // A different symbol is a different log.
    expect(loadCountLog('EURUSD').trades).toEqual([]);
  });

  it('returns an empty disabled log when nothing is stored', () => {
    expect(loadCountLog(SYM)).toEqual({
      version: COUNT_LOG_VERSION,
      symbol: SYM,
      enabled: false,
      trades: [],
    });
  });

  it('returns an empty log for corrupt JSON', () => {
    store.map.set(storageKey(SYM), '{"version":1,"trades":[');
    expect(loadCountLog(SYM).trades).toEqual([]);
    expect(loadCountLog(SYM).enabled).toBe(false);
  });

  it('discards a log written by another schema version', () => {
    store.map.set(
      storageKey(SYM),
      JSON.stringify({ version: COUNT_LOG_VERSION + 1, symbol: SYM, enabled: true, trades: [trade('a')] }),
    );
    expect(loadCountLog(SYM).trades).toEqual([]);
    expect(loadCountLog(SYM).enabled).toBe(false);
  });

  it('drops one bad trade while its good siblings survive', () => {
    store.map.set(
      storageKey(SYM),
      JSON.stringify({
        version: COUNT_LOG_VERSION,
        symbol: SYM,
        enabled: true,
        trades: [trade('a'), { id: 'rotten', outcome: 'win' }, trade('c')],
      }),
    );
    const loaded = loadCountLog(SYM);
    expect(loaded.trades.map((t) => t.id)).toEqual(['a', 'c']);
    expect(loaded.enabled).toBe(true);
  });

  it('caps at MAX_COUNTED_TRADES, dropping the oldest', () => {
    const many = Array.from({ length: MAX_COUNTED_TRADES + 5 }, (_, i) => trade(`t${i}`));
    saveCountLog(SYM, file(many));
    const loaded = loadCountLog(SYM);
    expect(loaded.trades).toHaveLength(MAX_COUNTED_TRADES);
    expect(loaded.trades[0]?.id).toBe('t5');
    expect(loaded.trades.at(-1)?.id).toBe(`t${MAX_COUNTED_TRADES + 4}`);
  });

  it('caps on load too, for a log that grew before the cap existed', () => {
    const many = Array.from({ length: MAX_COUNTED_TRADES + 3 }, (_, i) => trade(`t${i}`));
    store.map.set(
      storageKey(SYM),
      JSON.stringify({ version: COUNT_LOG_VERSION, symbol: SYM, enabled: true, trades: many }),
    );
    expect(loadCountLog(SYM).trades).toHaveLength(MAX_COUNTED_TRADES);
  });

  it('clears', () => {
    saveCountLog(SYM, file([trade('a')]));
    clearCountLog(SYM);
    expect(store.map.has(storageKey(SYM))).toBe(false);
    expect(loadCountLog(SYM).trades).toEqual([]);
  });
});

describe('defensive behaviour', () => {
  it('never throws when localStorage is missing entirely (SSR)', () => {
    install(undefined);
    expect(() => saveCountLog(SYM, file([trade('a')]))).not.toThrow();
    expect(() => clearCountLog(SYM)).not.toThrow();
    expect(loadCountLog(SYM).trades).toEqual([]);
  });

  it('never throws when the accessors throw', () => {
    const hostile = makeStorage({ throwOnGet: true, throwOnSet: true });
    install(hostile);
    expect(() => saveCountLog(SYM, file([trade('a')]))).not.toThrow();
    expect(() => clearCountLog(SYM)).not.toThrow();
    expect(loadCountLog(SYM).trades).toEqual([]);
  });
});
