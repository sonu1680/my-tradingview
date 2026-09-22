'use client';

import type { CountSummary } from '@/lib/counter/types';

/**
 * The live tally, pinned to the top-right of the chart area.
 *
 * Deliberately one line and deliberately small: it sits over the chart, so it
 * has to be readable at a glance and never in the way. It is rendered only
 * while Count mode is on — off, the chart is exactly as it was.
 *
 * Placement note: `IndicatorPanel` is absolutely positioned at `right-2 top-2`
 * and is 300px wide, so this sits at `right-[316px]` — same top edge, clear of
 * it rather than under it.
 *
 * Clicking it opens the Manual tab, where the full log lives.
 */

/** Thin spaces between thousands: `+1 240` reads faster than `+1240`. */
function pips(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  const digits = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${digits}`;
}

export default function CountBadge({
  summary,
  busy,
  error,
  onOpenLog,
}: {
  summary: CountSummary;
  busy: boolean;
  error: string | null;
  onOpenLog: () => void;
}) {
  const { total, wins, losses, open, winRate, totalPips } = summary;

  const parts: string[] = [
    `${total} trade${total === 1 ? '' : 's'}`,
    `${wins}W/${losses}L`,
    `${winRate.toFixed(1)}%`,
    `${pips(totalPips)} pips`,
  ];
  if (open > 0) parts.push(`${open} open`);

  return (
    <button
      type="button"
      onClick={onOpenLog}
      title={
        error !== null
          ? `Count mode — last evaluation failed: ${error}`
          : 'Count mode is on. Every position on the chart is logged, including ones drawn before you switched it on. Click to open the log.'
      }
      className={`absolute right-[316px] top-2 z-20 flex items-center gap-1.5 whitespace-nowrap border bg-term-panel/95 px-2 py-1 font-mono text-small tabular-nums shadow-sm transition-colors ${
        error !== null
          ? 'border-term-down/60 text-term-down hover:bg-term-down/10'
          : 'border-term-accent/60 text-term-text hover:border-term-accent hover:bg-term-accent/10'
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          error !== null
            ? 'bg-term-down'
            : busy
              ? 'animate-pulse bg-term-accent'
              : 'bg-term-accent'
        }`}
      />
      <span className="tracking-[0.01em] text-term-accent">Count</span>
      <span aria-hidden className="text-term-muted">
        ·
      </span>
      {parts.map((part, index) => (
        <span key={part} className="flex items-center gap-1.5">
          {index > 0 ? (
            <span aria-hidden className="text-term-muted">
              ·
            </span>
          ) : null}
          <span
            className={
              part.endsWith('open')
                ? 'text-term-dim'
                : part.endsWith('pips') && totalPips !== 0
                  ? totalPips > 0
                    ? 'text-term-up'
                    : 'text-term-down'
                  : undefined
            }
          >
            {part}
          </span>
        </span>
      ))}
    </button>
  );
}
