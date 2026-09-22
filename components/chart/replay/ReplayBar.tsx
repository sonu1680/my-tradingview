'use client';

import { useState } from 'react';
import { formatServerTime } from '../useCandleData';
import { REPLAY_SPEEDS, type ReplayControls } from './useReplay';

interface ReplayBarProps {
  replay: ReplayControls;
  /**
   * Bounds for the date picker, `YYYY-MM-DD` in server time. Optional: the API
   * reports its own "earliest available" message when the date is out of range.
   */
  minDate?: string;
  maxDate?: string;
}

/**
 * `YYYY-MM-DD` → unix seconds at 00:00 UTC. The timestamps in this app are
 * broker server time stored as if they were UTC (see `lib/candles/types.ts`),
 * so the date the user picks is a server-time date and MUST be built with
 * `Date.UTC`: `new Date(y, m, d)` would apply the viewer's offset and shift
 * the cutoff by up to a day.
 */
function dateToServerSeconds(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  // Rejects 2024-02-31 and friends, which Date.UTC would silently roll over.
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(ms / 1000);
}

/** `18432` → `18 432` (narrow no-break space), for the bar counter. */
function groupThousands(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

const BUTTON =
  'flex h-[26px] shrink-0 items-center justify-center rounded-md border border-term-border bg-term-panel px-2 text-body text-term-dim transition-colors hover:bg-term-border hover:text-term-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-term-panel disabled:hover:text-term-dim';

export default function ReplayBar({ replay, minDate, maxDate }: ReplayBarProps) {
  const [date, setDate] = useState('');
  const seconds = dateToServerSeconds(date);

  const readoutTime =
    replay.cutoffTime !== null ? formatServerTime(replay.cutoffTime, true) : '—';
  const readoutBar =
    replay.cutoffIndex !== null && replay.totalBars !== null
      ? `bar ${groupThousands(replay.cutoffIndex + 1)} / ${groupThousands(replay.totalBars)}`
      : null;

  return (
    // Fixed height in BOTH states so entering/leaving replay never reflows the
    // chart. Everything inside is 26px tall and vertically centred.
    <div
      role="toolbar"
      aria-label="Bar replay"
      className="flex h-10 shrink-0 items-center gap-3 overflow-x-auto border-b border-term-border bg-term-panel px-3 text-small"
    >
      {!replay.active ? (
        <>
          <label className="flex shrink-0 items-center gap-2">
            <span className="whitespace-nowrap text-tiny tracking-[0.01em] text-term-muted">
              Replay from{' '}
              <span className="normal-case tracking-normal">(server time)</span>
            </span>
            <input
              type="date"
              value={date}
              min={minDate}
              max={maxDate}
              onChange={(event) => setDate(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && seconds !== null) replay.start(seconds);
              }}
              aria-label="Replay from date, server time"
              className="h-[26px] rounded-md border border-term-border bg-term-bg px-1.5 font-mono text-small tabular-nums text-term-text [color-scheme:dark] focus:border-term-border-strong focus:outline-none"
            />
          </label>
          <button
            type="button"
            disabled={seconds === null}
            onClick={() => {
              if (seconds !== null) replay.start(seconds);
            }}
            title="Show the chart as of 00:00 server time on this date, then step forward bar by bar"
            className={`${BUTTON} font-medium tracking-[0.01em] text-term-accent hover:text-term-accent`}
          >
            Start replay
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            aria-label="Step back one bar"
            title="Step back one bar (←)"
            disabled={replay.atStart || replay.loading || replay.stepping}
            onClick={replay.stepBack}
            className={`${BUTTON} w-[34px]`}
          >
            <span aria-hidden>⏮</span>
          </button>
          <button
            type="button"
            aria-pressed={replay.playing}
            aria-label={replay.playing ? 'Pause replay' : 'Play replay'}
            title={`${replay.playing ? 'Pause' : 'Play'} (Space)`}
            disabled={replay.atEnd || replay.loading}
            onClick={replay.togglePlay}
            className={`${BUTTON} w-[34px] ${
              replay.playing ? 'bg-term-accent/20 text-term-accent hover:text-term-accent' : ''
            }`}
          >
            <span aria-hidden>{replay.playing ? '⏸' : '▶'}</span>
          </button>
          <button
            type="button"
            aria-label="Step forward one bar"
            title="Step forward one bar (→)"
            disabled={replay.atEnd || replay.loading}
            onClick={replay.step}
            className={`${BUTTON} w-[34px]`}
          >
            <span aria-hidden>⏭</span>
          </button>

          <div
            role="group"
            aria-label="Replay speed, bars per second"
            className="flex shrink-0 items-center rounded-md border border-term-border"
          >
            {REPLAY_SPEEDS.map((speed) => {
              const selected = replay.speed === speed;
              return (
                <button
                  key={speed}
                  type="button"
                  aria-pressed={selected}
                  title={`${speed} bar${speed === 1 ? '' : 's'} per second`}
                  onClick={() => replay.setSpeed(speed)}
                  className={`h-[24px] min-w-[34px] border-r border-term-border px-1.5 font-mono text-small tabular-nums transition-colors last:border-r-0 ${
                    selected
                      ? 'bg-term-accent/20 text-term-accent'
                      : 'text-term-dim hover:bg-term-border hover:text-term-text'
                  }`}
                >
                  {speed}×
                </button>
              );
            })}
          </div>

          <span
            className="flex min-w-0 shrink-0 items-center gap-2 whitespace-nowrap font-mono text-small tabular-nums text-term-text"
            aria-live="polite"
          >
            <span className="text-term-accent">Replay</span>
            <span className="text-term-muted">·</span>
            <span>{readoutTime}</span>
            {readoutBar !== null ? (
              <>
                <span className="text-term-muted">·</span>
                <span className="text-term-dim">{readoutBar}</span>
              </>
            ) : null}
          </span>

          {replay.loading || replay.stepping ? (
            <span className="flex shrink-0 items-center gap-1.5 text-tiny tracking-[0.01em] text-term-muted">
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse bg-term-accent" />
              {replay.loading ? 'loading' : 'stepping'}
            </span>
          ) : replay.atEnd ? (
            <span className="shrink-0 whitespace-nowrap rounded-md border border-term-border-strong px-1.5 py-px text-tiny tracking-[0.01em] text-term-dim">
              end of data
            </span>
          ) : null}

          {replay.error !== null ? (
            <span
              role="alert"
              className="truncate font-mono text-tiny text-term-down"
              title={replay.error}
            >
              {replay.error}
            </span>
          ) : null}

          <button
            type="button"
            onClick={replay.exit}
            title="Leave replay and return to the live tail"
            className={`${BUTTON} ml-auto tracking-[0.01em]`}
          >
            Exit replay
          </button>
        </>
      )}
    </div>
  );
}
