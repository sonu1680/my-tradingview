'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { formatServerTime } from '@/components/chart/useCandleData';
import { SYMBOL } from '@/lib/candles/types';
import type { ManualOutcome } from '@/lib/counter/manualEval';
import type { CountSummary, CountedTrade } from '@/lib/counter/types';

import { csvFilename, downloadCsv, toCsv, utcIso, type CsvValue } from './exportCsv';
import { printCountReport } from './printReport';

/**
 * The Count-mode log: the tally tiles, then every trade you took while the
 * mode was on, newest first.
 *
 * Two things this table exists to say out loud:
 *  - `open` is NOT a result. It is neutral grey, carries no pips, and is
 *    excluded from the win rate and every total. It resolves by itself as
 *    replay advances.
 *  - `never_triggered` is NOT a loss and is never red. Price did not reach the
 *    entry, so nothing was risked — it is a planning observation.
 *
 * The rows outlive the drawings on purpose: deleting a box does not un-take
 * the trade, so the row stays. That note is printed above the table rather
 * than left for the user to discover.
 */

/** XAUUSD quotes carry three decimals in the source CSVs. */
const PRICE_PRECISION = 3;

/* ------------------------------------------------------------------ */
/* Outcome presentation                                                */
/* ------------------------------------------------------------------ */

const OUTCOME_CLASS: Record<ManualOutcome, string> = {
  open: 'text-term-dim',
  win: 'text-term-up',
  loss: 'text-term-down',
  expired: 'text-term-dim',
  never_triggered: 'text-term-dim',
  invalid: 'text-term-accent',
};

const OUTCOME_LABEL: Record<ManualOutcome, string> = {
  open: 'open',
  win: 'win',
  loss: 'loss',
  expired: 'expired',
  never_triggered: 'not triggered',
  invalid: 'invalid',
};

const OUTCOME_TITLE: Record<ManualOutcome, string> = {
  open: 'Undecided as of the replay cutoff — price has reached neither the stop nor the target yet. It resolves on its own as replay advances.',
  win: 'Target reached before the stop.',
  loss: 'Stop reached before the target.',
  expired: 'Neither level was reached by the end of the loaded data; marked to market at the last minute.',
  never_triggered: 'Price never reached the entry. Not a loss — nothing was risked.',
  invalid: 'The box itself is not a trade (stop or target on the wrong side of entry).',
};

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

const CSV_HEADERS = [
  'drawn_at',
  'timeframe',
  'side',
  'entry',
  'stop',
  'target',
  'risk_pips',
  'reward_pips',
  'planned_rr',
  'outcome',
  'entry_time',
  'exit_time',
  'exit_price',
  'pips',
  'r',
  'minutes_held',
  'reason',
] as const;

/** One row per trade. Every timestamp is UTC ISO, unshifted server time. */
export function countLogCsv(trades: readonly CountedTrade[]): string {
  const rows: CsvValue[][] = trades.map((t) => [
    utcIso(t.loggedAt),
    t.timeframe,
    t.side,
    t.entry,
    t.stop,
    t.target,
    t.riskPips,
    t.rewardPips,
    t.plannedRR,
    t.outcome,
    t.entryTime === undefined ? null : utcIso(t.entryTime),
    t.exitTime === undefined ? null : utcIso(t.exitTime),
    t.exitPrice ?? null,
    t.pips ?? null,
    t.r ?? null,
    t.minutesHeld ?? null,
    t.reason ?? null,
  ]);
  return toCsv(CSV_HEADERS, rows);
}

/* ------------------------------------------------------------------ */
/* Tiles                                                               */
/* ------------------------------------------------------------------ */

function Tile({
  label,
  value,
  hint,
  tone = 'neutral',
  title,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'good' | 'bad' | 'neutral';
  title?: string;
}) {
  return (
    <div
      title={title}
      className="flex min-w-0 flex-col gap-0.5 rounded-md border border-term-border bg-term-bg px-2 py-1.5"
    >
      <span className="truncate text-tiny tracking-[0.01em] text-term-muted">
        {label}
      </span>
      <span
        className={`font-mono text-lead tabular-nums ${
          tone === 'good'
            ? 'text-term-up'
            : tone === 'bad'
              ? 'text-term-down'
              : 'text-term-text'
        }`}
      >
        {value}
      </span>
      {hint !== undefined ? (
        <span className="truncate text-tiny text-term-dim">{hint}</span>
      ) : null}
    </div>
  );
}

function CountTiles({ summary }: { summary: CountSummary }) {
  return (
    <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-6">
      <Tile
        label="Trades"
        value={String(summary.total)}
        hint={`${summary.decided} decided`}
        title="Every position logged while Count mode was on."
      />
      <Tile
        label="Win rate"
        value={`${summary.winRate.toFixed(1)}%`}
        hint={`${summary.wins}W / ${summary.losses}L`}
        title="Over wins + losses only. Open, expired, not-triggered and invalid are all outside the denominator."
      />
      <Tile
        label="Total pips"
        value={signed(summary.totalPips, 0)}
        tone={summary.totalPips > 0 ? 'good' : summary.totalPips < 0 ? 'bad' : 'neutral'}
        hint={`avg ${signed(summary.avgPips, 0)}`}
        title="Over win + loss + expired. An open trade has no P&L yet."
      />
      <Tile
        label="Total R"
        value={signed(summary.totalR, 2)}
        tone={summary.totalR > 0 ? 'good' : summary.totalR < 0 ? 'bad' : 'neutral'}
        hint={`expectancy ${signed(summary.expectancyR, 2)}R`}
      />
      <Tile
        label="Avg planned R:R"
        value={summary.avgPlannedRR === null ? '—' : summary.avgPlannedRR.toFixed(2)}
        hint="what the win rate must clear"
        title="Mean of the planned reward/risk over the geometrically valid boxes. Compare the win rate against this, not against 50%."
      />
      <Tile
        label="Open"
        value={String(summary.open)}
        hint={`${summary.expired} exp · ${summary.neverTriggered} n/t · ${summary.invalid} inv`}
        title="Undecided as of the replay cutoff. They resolve as replay advances."
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

const TH =
  'whitespace-nowrap px-2 py-1.5 text-small font-medium tracking-[0.01em] text-term-muted';
const TD = 'whitespace-nowrap px-2 py-1 font-mono text-small tabular-nums';

export default function CountLogTable({
  trades,
  summary,
  error,
  onClear,
}: {
  trades: readonly CountedTrade[];
  summary: CountSummary;
  error: string | null;
  onClear: () => void;
}) {
  // Newest first. The log itself is append-ordered, so this is a display
  // choice and never mutates the caller's array.
  /**
   * Newest first BY WHEN THE TRADE WAS DRAWN.
   *
   * Append order is not good enough any more: switching Count mode on sweeps
   * up the positions already on the chart, and those arrive in chart order, so
   * an old setup could otherwise sit above one drawn minutes ago. Append order
   * breaks ties, which keeps the sort stable for trades drawn in the same
   * second.
   */
  const sorted = useMemo(
    () =>
      trades
        .map((trade, index) => ({ trade, index }))
        .sort((a, b) => b.trade.loggedAt - a.trade.loggedAt || b.index - a.index)
        .map((entry) => entry.trade),
    [trades],
  );

  const [confirming, setConfirming] = useState(false);
  // The print frame can be refused (a locked-down browser); say so rather than
  // appearing to do nothing.
  const [printFailed, setPrintFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const askClear = () => {
    setConfirming(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setConfirming(false), 4000);
  };

  const cancelClear = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setConfirming(false);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
      <CountTiles summary={summary} />

      {error !== null ? (
        <p className="rounded-md border border-term-down/50 bg-term-down/10 px-2 py-1 font-mono text-small text-term-down">
          count evaluation failed — {error}
        </p>
      ) : null}

      {printFailed ? (
        <p className="rounded-md border border-term-down/50 bg-term-down/10 px-2 py-1 text-small text-term-down">
          Could not open the print view — your browser blocked it. Export CSV still works.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-term-border px-2 py-1">
        <span className="min-w-0 text-tiny text-term-dim">
          This log mirrors the chart: delete a position and its row goes with it,
          and undo brings it back. Clear all wipes both.
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={sorted.length === 0}
            title="Open the print dialog — choose “Save as PDF” to keep a copy"
            onClick={() => {
              if (!printCountReport(SYMBOL, sorted, summary)) {
                setPrintFailed(true);
              }
            }}
            className="rounded-md border border-term-border px-2 py-0.5 text-tiny tracking-[0.01em] text-term-dim transition-colors hover:border-term-accent hover:text-term-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export PDF
          </button>
          <button
            type="button"
            disabled={sorted.length === 0}
            onClick={() =>
              downloadCsv(csvFilename('count-log', 'multi-tf'), countLogCsv(trades))
            }
            className="rounded-md border border-term-border px-2 py-0.5 text-tiny tracking-[0.01em] text-term-dim transition-colors hover:border-term-accent hover:text-term-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export CSV
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                title="Confirm — delete every logged trade"
                onClick={() => {
                  cancelClear();
                  onClear();
                }}
                className="rounded-md border border-term-down/60 px-2 py-0.5 text-tiny tracking-[0.01em] text-term-down transition-colors hover:bg-term-down/15"
              >
                Confirm clear
              </button>
              <button
                type="button"
                onClick={cancelClear}
                className="rounded-md border border-term-border px-2 py-0.5 text-tiny tracking-[0.01em] text-term-dim transition-colors hover:text-term-text"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={sorted.length === 0}
              onClick={askClear}
              className="rounded-md border border-term-border px-2 py-0.5 text-tiny tracking-[0.01em] text-term-dim transition-colors hover:border-term-down hover:text-term-down disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear log
            </button>
          )}
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="max-w-[80ch] px-2 py-3 text-body text-term-dim">
          Nothing logged yet. Switch Count mode on and every position on the chart is
          evaluated and appended here — the ones already drawn as well as each new
          one. A trade already in this log is never counted twice.
        </p>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border border-term-border">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-term-panel">
              <tr className="border-b border-term-border">
                <th className={`${TH} text-left`}>Drawn</th>
                <th className={`${TH} text-left`}>TF</th>
                <th className={`${TH} text-left`}>Side</th>
                <th className={`${TH} text-right`}>Entry</th>
                <th className={`${TH} text-right`}>Stop</th>
                <th className={`${TH} text-right`}>Target</th>
                <th className={`${TH} text-right`} title="Reward / risk as drawn.">
                  R:R
                </th>
                <th className={`${TH} text-left`}>Outcome</th>
                <th className={`${TH} text-right`}>Pips</th>
                <th className={`${TH} text-right`}>R</th>
                <th className={`${TH} text-right`}>Mins</th>
                <th className={`${TH} text-left`}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-term-border/50 last:border-b-0 hover:bg-term-accent/5"
                >
                  <td className={`${TD} text-left text-term-dim`}>
                    {formatServerTime(t.loggedAt, true)}
                  </td>
                  <td className={`${TD} text-left text-term-dim`}>{t.timeframe}</td>
                  <td
                    className={`${TD} text-left ${
                      t.side === 'long' ? 'text-term-up' : 'text-term-down'
                    }`}
                  >
                    {t.side}
                  </td>
                  <td className={`${TD} text-right`}>{t.entry.toFixed(PRICE_PRECISION)}</td>
                  <td className={`${TD} text-right text-term-dim`}>
                    {t.stop.toFixed(PRICE_PRECISION)}
                  </td>
                  <td className={`${TD} text-right text-term-dim`}>
                    {t.target.toFixed(PRICE_PRECISION)}
                  </td>
                  <td className={`${TD} text-right text-term-dim`}>
                    {t.plannedRR === null ? '—' : t.plannedRR.toFixed(2)}
                  </td>
                  <td className={`${TD} text-left`}>
                    <span title={OUTCOME_TITLE[t.outcome]} className={OUTCOME_CLASS[t.outcome]}>
                      {OUTCOME_LABEL[t.outcome]}
                    </span>
                  </td>
                  <td
                    className={`${TD} text-right ${
                      t.pips === undefined
                        ? 'text-term-muted'
                        : t.pips > 0
                          ? 'text-term-up'
                          : t.pips < 0
                            ? 'text-term-down'
                            : 'text-term-dim'
                    }`}
                  >
                    {t.pips === undefined ? '—' : signed(t.pips, 0)}
                  </td>
                  <td
                    className={`${TD} text-right ${
                      t.r === undefined
                        ? 'text-term-muted'
                        : t.r > 0
                          ? 'text-term-up'
                          : t.r < 0
                            ? 'text-term-down'
                            : 'text-term-dim'
                    }`}
                  >
                    {t.r === undefined ? '—' : signed(t.r, 2)}
                  </td>
                  <td className={`${TD} text-right text-term-dim`}>
                    {t.minutesHeld === undefined ? '—' : t.minutesHeld}
                  </td>
                  <td className="max-w-[28ch] truncate px-2 py-1 text-left text-small text-term-dim">
                    {t.reason ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
