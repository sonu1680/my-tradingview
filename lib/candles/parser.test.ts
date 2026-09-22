import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { parseCsvFile } from './parser';
import { TIMEFRAME_MINUTES } from './types';

const FIXTURES = path.join(__dirname, '__fixtures__');
const fixture = (tf: string) => path.join(FIXTURES, `XAUUSDm_${tf}_5years.csv`);

describe('parseCsvFile', () => {
  it('parses the happy path exactly and skips the header row', async () => {
    const s = await parseCsvFile(fixture('M1'), 'M1');

    expect(s.timeframe).toBe('M1');
    expect(s.count).toBe(10);
    expect(s.skippedRows).toBe(0);

    // The header must not have become a bar.
    expect(s.time[0]).not.toBeNaN();

    // Row 1: 2021.09.21 12:18,1768.577,1769.113,1767.945,1768.777,181,200,0
    expect(s.time[0]).toBe(1632226680);
    expect(s.open[0]).toBeCloseTo(1768.577, 9);
    expect(s.high[0]).toBeCloseTo(1769.113, 9);
    expect(s.low[0]).toBeCloseTo(1767.945, 9);
    expect(s.close[0]).toBeCloseTo(1768.777, 9);
    expect(s.volume[0]).toBe(181);

    // Last row, 9 minutes later.
    expect(s.time[9]).toBe(1632226680 + 9 * 60);
    expect(s.volume[9]).toBe(190);

    // Typed-array widths from the contract.
    expect(s.time).toBeInstanceOf(Int32Array);
    expect(s.open).toBeInstanceOf(Float64Array);
    expect(s.volume).toBeInstanceOf(Int32Array);

    // Arrays are trimmed to exactly `count`, not left at doubled capacity.
    expect(s.time.length).toBe(10);
    expect(s.close.length).toBe(10);
  });

  it('interprets the naive server timestamp as UTC, never local time', async () => {
    const s = await parseCsvFile(fixture('M1'), 'M1');
    // 2021.09.21 12:18 read as UTC.
    expect(s.time[0]).toBe(Date.UTC(2021, 8, 21, 12, 18) / 1000);
    // Sanity: rendering it back in UTC reproduces the source string.
    expect(new Date(s.time[0] * 1000).toISOString()).toBe('2021-09-21T12:18:00.000Z');
  });

  it('skips malformed rows, counts them, and never throws', async () => {
    const s = await parseCsvFile(fixture('M5'), 'M5');

    // 3 good rows: 00:00, 00:10 (CRLF-terminated), 00:30 (no trailing newline).
    expect(s.count).toBe(3);
    // 4 malformed: short row, non-numeric open, month 13, 9-field row.
    // The blank line is not counted as a row.
    expect(s.skippedRows).toBe(4);

    expect(s.time[0]).toBe(Date.UTC(2022, 1, 1, 0, 0) / 1000);
    expect(s.time[1]).toBe(Date.UTC(2022, 1, 1, 0, 10) / 1000);
    expect(s.time[2]).toBe(Date.UTC(2022, 1, 1, 0, 30) / 1000);
    expect(s.open[1]).toBeCloseTo(1803, 9);
    expect(s.volume[2]).toBe(16);
  });

  it('leaves structural gaps alone', async () => {
    const s = await parseCsvFile(fixture('M15'), 'M15');
    expect(s.count).toBe(5);

    const deltas: number[] = [];
    for (let i = 1; i < s.count; i++) deltas.push(s.time[i] - s.time[i - 1]);
    const step = TIMEFRAME_MINUTES.M15 * 60;

    // A weekend gap survives verbatim: no synthetic bars were inserted.
    expect(deltas).toEqual([step, step, 2 * 24 * 3600 + 75 * 60, step]);
    expect(deltas.some((d) => d > step)).toBe(true);
  });

  it('keeps timestamps strictly ascending on real-shaped input', async () => {
    const s = await parseCsvFile(fixture('H1'), 'H1');
    expect(s.count).toBe(25);
    for (let i = 1; i < s.count; i++) {
      expect(s.time[i]).toBeGreaterThan(s.time[i - 1]);
    }
  });

  it('rejects a missing file by rejecting the promise', async () => {
    await expect(parseCsvFile(fixture('NOPE'), 'D1')).rejects.toThrow();
  });
});
