'use client';

import { SYMBOL, type Timeframe } from '@/lib/candles/types';

/**
 * Client-side CSV export.
 *
 * No library: a CSV is a quoting rule and a Blob, and pulling a dependency in
 * for that would add more surface than it removes.
 *
 * Two rules the rest of the app depends on:
 *  - every field is quoted and every embedded quote is doubled, so a value
 *    containing a comma, a quote or a newline cannot shift the columns;
 *  - timestamps go out as UTC ISO strings. The source CSVs are broker SERVER
 *    time and the app never shifts them, so formatting with local getters
 *    would silently rewrite every timestamp by the reader's offset.
 */

/** RFC 4180 field: always quoted, inner quotes doubled. */
function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return quote('');
  return quote(typeof value === 'number' ? String(value) : value);
}

export type CsvValue = string | number | null | undefined;

/** Builds a CRLF-delimited CSV. CRLF is what Excel expects. */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvValue[])[],
): string {
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) lines.push(row.map(cell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** UTC ISO seconds, e.g. `2025-03-04T13:00:00Z`. Server time, unshifted. */
export function utcIso(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 19)}Z`;
}

/** `20260920-114233` — a filename-safe UTC stamp for the download name. */
function fileStamp(now: Date): string {
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`;
}

/** `XAUUSDm_H1_trades_20260920-114233.csv` */
export function csvFilename(kind: string, timeframe: Timeframe | 'multi-tf'): string {
  return `${SYMBOL}_${timeframe}_${kind}_${fileStamp(new Date())}.csv`;
}

/**
 * Triggers a download from a Blob. The object URL is revoked on the next
 * task: revoking synchronously can cancel the download in some browsers.
 */
export function downloadCsv(filename: string, csv: string): void {
  // A BOM so Excel reads it as UTF-8 rather than the local codepage.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
