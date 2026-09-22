'use client';

import { TIMEFRAMES, type Timeframe } from '@/lib/candles/types';

interface TimeframeBarProps {
  value: Timeframe;
  onChange: (timeframe: Timeframe) => void;
  /** Timeframes the API reports as unavailable render disabled, never hidden. */
  unavailable: ReadonlySet<Timeframe>;
}

const GROUPS: ReadonlyArray<{ label: string; members: readonly Timeframe[] }> = [
  { label: 'Min', members: TIMEFRAMES.filter((tf) => tf.startsWith('M') && tf !== 'MN1') },
  { label: 'Hour', members: TIMEFRAMES.filter((tf) => tf.startsWith('H')) },
  { label: 'Day+', members: ['D1', 'W1', 'MN1'] },
];

export default function TimeframeBar({
  value,
  onChange,
  unavailable,
}: TimeframeBarProps) {
  return (
    // The 21 buttons are ~40px each at `--text-body`. The bar wraps whole
    // groups onto the next line rather than overflowing the header, and each
    // group stays intact because only this outer row wraps.
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
      {GROUPS.map((group) => (
        <div key={group.label} className="flex shrink-0 items-center gap-1.5">
          <span className="shrink-0 text-tiny font-medium text-term-muted">
            {group.label}
          </span>
          {/*
            A segmented control: one inset track holding the group, rather than
            21 separate outlined boxes. The track is what makes a dense row of
            options read as one control instead of a wall of buttons.
          */}
          <div className="flex items-center gap-0.5 rounded-lg bg-term-bg/70 p-0.5 ring-1 ring-inset ring-term-border">
            {group.members.map((tf) => {
              const active = tf === value;
              const disabled = unavailable.has(tf);
              return (
                <button
                  key={tf}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  title={disabled ? `${tf} — not available` : tf}
                  onClick={() => onChange(tf)}
                  className={[
                    // 26px tall: `--text-body` is 14px on a 1.5 line height, so a 22px box
                    // would clip the descenders of the group codes.
                    'h-[26px] min-w-[34px] rounded-md px-1.5 text-body font-medium tabular-nums transition-colors duration-150',
                    disabled
                      ? 'cursor-not-allowed text-term-border-strong line-through'
                      : active
                        ? // The selected pill carries the only fill in the track,
                          // so the current timeframe is findable at a glance.
                          'bg-term-accent font-semibold text-[#171a21] shadow-sm shadow-black/30'
                        : 'text-term-dim hover:bg-white/[0.06] hover:text-term-text',
                  ].join(' ')}
                >
                  {tf}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
