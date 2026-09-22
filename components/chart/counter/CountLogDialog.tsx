'use client';

import { useEffect } from 'react';
import CountLogTable from './CountLogTable';
import type { CountModeState } from './useCountMode';

/**
 * Count mode's switch and its full log.
 *
 * This used to live in the Manual tab of the strategy-tester drawer. That
 * drawer is gone, so the feature owns its own surface: the switch has to be
 * reachable when the mode is OFF (the on-chart badge only renders while it is
 * on), which means it cannot hang off the badge alone. The header button opens
 * this; so does clicking the badge.
 */

interface Props {
  countMode: CountModeState;
  onClose: () => void;
}

export default function CountLogDialog({ countMode, onClose }: Props) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    // Capture, so Escape closes this rather than clearing a drawing selection
    // underneath it.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Count mode"
        aria-modal="true"
        className="flex h-[min(660px,88vh)] w-[min(1040px,95vw)] flex-col rounded-xl border border-term-border bg-term-raised shadow-2xl shadow-black/70 ring-1 ring-white/[0.04]"
      >
        <header className="flex items-center gap-3 border-b border-term-border px-5 py-3.5">
          <h2 className="text-head font-semibold tracking-wide text-term-text">
            Count mode
          </h2>
          <span
            className={`font-mono text-tiny tracking-[0.01em] ${
              countMode.enabled ? 'text-term-accent' : 'text-term-muted'
            }`}
          >
            {countMode.enabled ? 'recording' : 'off'}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex h-7 w-7 items-center justify-center text-term-muted transition-colors hover:bg-term-border hover:text-term-text"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-term-border bg-term-bg px-2.5 py-2">
            <label className="flex shrink-0 cursor-pointer items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={countMode.enabled}
                onChange={(event) => countMode.setEnabled(event.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-term-accent)]"
              />
              <span className="whitespace-nowrap text-tiny font-semibold tracking-[0.01em] text-term-dim">
                Count mode
              </span>
            </label>
            <span className="min-w-0 flex-1 text-tiny text-term-dim">
              {countMode.enabled
                ? 'On — every position on the chart is logged, including ones drawn before you switched it on. In replay a fresh trade reads OPEN and resolves as you step forward.'
                : 'Off — nothing is logged. Switching it on sweeps up every position already on the chart, then keeps logging each new one. Trades already in the log are never counted twice.'}
            </span>
          </div>

          <CountLogTable
            trades={countMode.trades}
            summary={countMode.summary}
            error={countMode.error}
            onClear={countMode.clear}
          />
        </div>
      </div>
    </div>
  );
}
