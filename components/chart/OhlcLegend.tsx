'use client';

import type { Bar, Timeframe } from '@/lib/candles/types';
import {
  formatPrice,
  formatServerTime,
  formatVolume,
  isIntraday,
} from './useCandleData';

interface OhlcLegendProps {
  symbol: string;
  timeframe: Timeframe;
  /** Bar under the crosshair, or the latest bar when the pointer is away. */
  bar: Bar | null;
  /** True when `bar` is the latest bar rather than a hovered one. */
  isLatest: boolean;
  pricePrecision: number;
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-tiny tracking-[0.01em] text-term-muted">{label}</span>
      <span className={`font-mono text-body tabular-nums ${tone}`}>{value}</span>
    </span>
  );
}

export default function OhlcLegend({
  symbol,
  timeframe,
  bar,
  isLatest,
  pricePrecision,
}: OhlcLegendProps) {
  const up = bar !== null && bar.close >= bar.open;
  const tone = bar === null ? 'text-term-dim' : up ? 'text-term-up' : 'text-term-down';

  return (
    // At `--text-body` the full O/H/L/C/Vol row is far wider than it was, so the
    // legend is capped short of the indicator panel's 300px column and wraps
    // inside that box instead of sliding under the panel or off the edge.
    <div className="pointer-events-none absolute left-2 top-2 z-10 max-w-[calc(100%-320px)] select-none">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-sm border border-term-border bg-term-bg/80 px-2 py-1.5 backdrop-blur-sm">
        <span className="text-body font-semibold tracking-wide text-term-text">
          {symbol}
        </span>
        <span className="text-small font-medium tracking-[0.01em] text-term-accent">
          {timeframe}
        </span>

        {bar === null ? (
          <span className="font-mono text-body text-term-muted">no bar</span>
        ) : (
          <>
            <span className="font-mono text-body tabular-nums text-term-dim">
              {formatServerTime(bar.time, isIntraday(timeframe))}
            </span>
            <Field label="O" value={formatPrice(bar.open, pricePrecision)} tone={tone} />
            <Field label="H" value={formatPrice(bar.high, pricePrecision)} tone={tone} />
            <Field label="L" value={formatPrice(bar.low, pricePrecision)} tone={tone} />
            <Field label="C" value={formatPrice(bar.close, pricePrecision)} tone={tone} />
            <Field label="Vol" value={formatVolume(bar.volume)} tone="text-term-dim" />
            {isLatest ? (
              <span className="text-tiny tracking-[0.01em] text-term-muted">
                latest
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
