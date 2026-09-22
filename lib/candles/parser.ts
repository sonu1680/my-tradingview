/**
 * Streaming CSV -> columnar CandleSeries parser for MetaTrader 5 exports.
 *
 * Input shape (header row present):
 *   time,open,high,low,close,tick_volume,spread,real_volume
 *   2021.09.21 12:18,1768.57700000,1769.11300000,1767.94500000,1768.37300000,181,200,0
 *
 * `time` is broker SERVER time with no zone. We deliberately read it as UTC
 * (Date.UTC) so no machine-local offset is ever baked into the data; the UI
 * labels the axis "server time".
 *
 * Performance notes (M1 is 141 MB / 1.76M rows):
 *  - We stream with fs.createReadStream instead of readFileSync, so peak RSS is
 *    the typed arrays plus one 64 KiB chunk, not 141 MB of string on top.
 *  - Chunks are decoded as latin1. The data is pure ASCII, latin1 decoding is a
 *    straight byte->char map (no UTF-8 validation), and a latin1 decode can never
 *    split a multi-byte sequence across a chunk boundary.
 *  - No regex and no `new Date(string)` per row: fields are located with
 *    indexOf(',') and the fixed-width timestamp is read digit by digit with
 *    charCodeAt.
 */

import fs from 'node:fs';
import type { CandleSeries, Timeframe } from './types';

const COMMA = ',';
const NEWLINE = '\n';
const CR = 13;
const ZERO = 48;
const NINE = 57;

/** Average bytes per row in the real exports (~78). Used only to size the first allocation. */
const BYTES_PER_ROW_ESTIMATE = 78;
const MIN_CAPACITY = 1024;
/** Above this fill ratio, keep the oversized buffer and return a view instead of copying. */
const TRIM_COPY_THRESHOLD = 0.85;

interface Columns {
  time: Int32Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Int32Array;
  spread: Int32Array;
  capacity: number;
}

function allocate(capacity: number): Columns {
  return {
    time: new Int32Array(capacity),
    open: new Float64Array(capacity),
    high: new Float64Array(capacity),
    low: new Float64Array(capacity),
    close: new Float64Array(capacity),
    volume: new Int32Array(capacity),
    spread: new Int32Array(capacity),
    capacity,
  };
}

function grow(cols: Columns): void {
  const next = cols.capacity * 2;
  const t = new Int32Array(next); t.set(cols.time); cols.time = t;
  const o = new Float64Array(next); o.set(cols.open); cols.open = o;
  const h = new Float64Array(next); h.set(cols.high); cols.high = h;
  const l = new Float64Array(next); l.set(cols.low); cols.low = l;
  const c = new Float64Array(next); c.set(cols.close); cols.close = c;
  const v = new Int32Array(next); v.set(cols.volume); cols.volume = v;
  const s = new Int32Array(next); s.set(cols.spread); cols.spread = s;
  cols.capacity = next;
}

/** Read `len` ASCII digits starting at `at`; -1 when any char is not a digit. */
function digits(s: string, at: number, len: number): number {
  let n = 0;
  for (let i = at; i < at + len; i++) {
    const c = s.charCodeAt(i);
    if (c < ZERO || c > NINE) return -1;
    n = n * 10 + (c - ZERO);
  }
  return n;
}

/**
 * `YYYY.MM.DD HH:MM` (exactly 16 chars) -> unix seconds, or NaN when malformed.
 * Field widths are fixed, so this is pure index arithmetic. Components are range
 * checked because Date.UTC happily normalises month 13 into the next year.
 */
function parseServerTime(s: string, start: number, end: number): number {
  if (end - start !== 16) return NaN;
  if (s.charCodeAt(start + 4) !== 46 /* . */) return NaN;
  if (s.charCodeAt(start + 7) !== 46) return NaN;
  if (s.charCodeAt(start + 10) !== 32 /* space */) return NaN;
  if (s.charCodeAt(start + 13) !== 58 /* : */) return NaN;

  const year = digits(s, start, 4);
  const month = digits(s, start + 5, 2);
  const day = digits(s, start + 8, 2);
  const hour = digits(s, start + 11, 2);
  const minute = digits(s, start + 14, 2);

  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return NaN;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return NaN;

  const ms = Date.UTC(year, month - 1, day, hour, minute);
  // Catches impossible civil dates such as 2022.02.31, which Date.UTC rolls over.
  const d = new Date(ms);
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return NaN;
  return ms / 1000;
}

/** Number() but rejecting '' (which Number turns into 0) and non-finite results. */
function parseNumber(s: string, start: number, end: number): number {
  if (end <= start) return NaN;
  const n = Number(s.slice(start, end));
  return Number.isFinite(n) ? n : NaN;
}

export async function parseCsvFile(
  filePath: string,
  timeframe: Timeframe,
): Promise<CandleSeries> {
  // Size the first allocation from the file size so the common case needs zero or
  // one regrowth. We then double on overflow rather than doing a separate
  // newline-counting pass: a second pass would mean reading 141 MB off disk twice,
  // while doubling costs a handful of amortised memcpys and at most 2x capacity,
  // which the final .slice() gives straight back.
  let initial = MIN_CAPACITY;
  try {
    const size = fs.statSync(filePath).size;
    initial = Math.max(MIN_CAPACITY, Math.ceil(size / BYTES_PER_ROW_ESTIMATE) + 16);
  } catch {
    // statSync failing here is fine; createReadStream reports the real error below.
  }

  const cols = allocate(initial);
  let count = 0;
  let skippedRows = 0;
  let sawFirstLine = false;
  let outOfOrder = 0;
  let lastTime = -Infinity;

  const consumeLine = (line: string, from: number, to: number): void => {
    // Trim a trailing \r so CRLF files parse identically.
    let end = to;
    if (end > from && line.charCodeAt(end - 1) === CR) end--;
    if (end <= from) return; // blank line: not a row, not an error

    // Locate the 8 fields. A row with any other field count is malformed.
    const c1 = line.indexOf(COMMA, from);
    if (c1 < 0 || c1 >= end) { reject(); return; }
    const c2 = line.indexOf(COMMA, c1 + 1);
    if (c2 < 0 || c2 >= end) { reject(); return; }
    const c3 = line.indexOf(COMMA, c2 + 1);
    if (c3 < 0 || c3 >= end) { reject(); return; }
    const c4 = line.indexOf(COMMA, c3 + 1);
    if (c4 < 0 || c4 >= end) { reject(); return; }
    const c5 = line.indexOf(COMMA, c4 + 1);
    if (c5 < 0 || c5 >= end) { reject(); return; }
    const c6 = line.indexOf(COMMA, c5 + 1);
    if (c6 < 0 || c6 >= end) { reject(); return; }
    const c7 = line.indexOf(COMMA, c6 + 1);
    if (c7 < 0 || c7 >= end) { reject(); return; }
    const c8 = line.indexOf(COMMA, c7 + 1);
    if (c8 >= 0 && c8 < end) { reject(); return; } // 9+ fields

    const time = parseServerTime(line, from, c1);
    const open = parseNumber(line, c1 + 1, c2);
    const high = parseNumber(line, c2 + 1, c3);
    const low = parseNumber(line, c3 + 1, c4);
    const close = parseNumber(line, c4 + 1, c5);
    const volume = parseNumber(line, c5 + 1, c6);
    // c6..c7 is the spread in MT5 points; the backtest charges it as a real
    // cost, so it is kept. c7..end is real_volume, which is 0 throughout these
    // exports and is still deliberately ignored.
    const spread = parseNumber(line, c6 + 1, c7);

    if (
      Number.isNaN(time) ||
      Number.isNaN(open) || Number.isNaN(high) ||
      Number.isNaN(low) || Number.isNaN(close) ||
      Number.isNaN(volume) ||
      Number.isNaN(spread)
    ) {
      reject();
      return;
    }

    if (count === cols.capacity) grow(cols);
    cols.time[count] = time;
    cols.open[count] = open;
    cols.high[count] = high;
    cols.low[count] = low;
    cols.close[count] = close;
    cols.volume[count] = volume;
    cols.spread[count] = spread;
    count++;

    // The exports are already sorted with no duplicates; we assert that rather
    // than paying to sort, and surface violations instead of hiding them.
    if (time <= lastTime) outOfOrder++;
    lastTime = time;

    function reject(): void {
      // The first line is the header (`time,open,...`), which is expected to fail
      // to parse. Drop it silently; every later failure is a real malformed row.
      if (!sawFirstLine) return;
      skippedRows++;
    }
  };

  await new Promise<void>((resolve, rejectPromise) => {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 16 });
    let carry = '';

    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => {
      const text = carry + (chunk as Buffer).toString('latin1');
      let start = 0;
      for (;;) {
        const nl = text.indexOf(NEWLINE, start);
        if (nl < 0) break;
        consumeLine(text, start, nl);
        sawFirstLine = true;
        start = nl + 1;
      }
      carry = start === 0 ? text : text.slice(start);
    });
    stream.on('end', () => {
      // Final line when the file does not end in a newline.
      if (carry.length > 0) {
        consumeLine(carry, 0, carry.length);
        sawFirstLine = true;
      }
      resolve();
    });
  });

  if (outOfOrder > 0) {
    console.warn(
      `[candles] ${timeframe}: ${outOfOrder} non-ascending timestamp(s) in ${filePath}; ` +
        'data was left in file order (never reordered).',
    );
  }

  // Trim to exactly `count`. When the size estimate was close (the normal case)
  // we hand back a subarray view: same length, zero copy, no transient doubling
  // of a 70 MB column set. When it overshot badly we pay for a real copy so the
  // slack is actually released.
  const tight = count >= cols.capacity * TRIM_COPY_THRESHOLD;
  const trimI = (a: Int32Array): Int32Array => (tight ? a.subarray(0, count) : a.slice(0, count));
  const trimF = (a: Float64Array): Float64Array => (tight ? a.subarray(0, count) : a.slice(0, count));

  return {
    timeframe,
    time: trimI(cols.time),
    open: trimF(cols.open),
    high: trimF(cols.high),
    low: trimF(cols.low),
    close: trimF(cols.close),
    volume: trimI(cols.volume),
    spread: trimI(cols.spread),
    count,
    skippedRows,
  };
}
