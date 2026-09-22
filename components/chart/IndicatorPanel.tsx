'use client';

import { useEffect, useRef, useState } from 'react';
import {
  LEVEL_MODES,
  PINE_MAX_OBJECTS,
  THRESHOLD_MODES,
  isLevelMode,
  type BigBodyParams,
  type BigBodyStats,
  type ThresholdMode,
} from '@/lib/indicators/types';
import type { BigBodyStyle } from './primitives/BigBodyPrimitive';

interface IndicatorPanelProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  params: BigBodyParams;
  onParamsChange: (params: BigBodyParams) => void;
  style: BigBodyStyle;
  onStyleChange: (style: BigBodyStyle) => void;
  stats: BigBodyStats | null;
  loading: boolean;
  /** Non-fatal: the candles are fine, only the overlay failed. */
  error: string | null;
}

/** Keys the user types into. Typing "2000" must not fire four requests. */
type NumericKey =
  | 'thresholdPips'
  | 'thresholdPercent'
  | 'atrPeriod'
  | 'atrMultiple'
  | 'manualPip'
  | 'maxDays'
  | 'minGap';

const COMMIT_DELAY_MS = 350;

/** Short enough to sit in the mode strip; `pips` is Pine's own rule. */
const THRESHOLD_MODE_LABELS: Record<ThresholdMode, string> = {
  pips: 'Pips',
  percent: 'Percent',
  atr: 'ATR',
};

const ROW = 'flex items-center justify-between gap-2 py-[3px]';
/* No `leading-*`: every `--text-*` token carries its own line height. A label
   that outgrows its row wraps onto a second line rather than being clipped,
   which is why the row centres rather than baselines. */
const LABEL = 'text-small text-term-dim';
const NUMBER_INPUT =
  'h-[26px] w-[76px] shrink-0 rounded-md border border-term-border bg-term-bg px-1.5 text-right font-mono text-small tabular-nums text-term-text outline-none focus:border-term-accent';
const CHECKBOX = 'h-3.5 w-3.5 shrink-0 accent-term-accent';

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="truncate text-tiny tracking-[0.01em] text-term-muted">
        {label}
      </span>
      <span className="font-mono text-body tabular-nums text-term-text">
        {value.toLocaleString('en-US')}
      </span>
    </div>
  );
}

function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={ROW}>
      <span className={LABEL}>{label}</span>
      <span className="flex items-center gap-1">
        <span className="font-mono text-tiny tabular-nums text-term-muted">
          {value}
        </span>
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-[24px] w-[34px] shrink-0 cursor-pointer rounded-md border border-term-border bg-term-bg p-0"
        />
      </span>
    </label>
  );
}

export default function IndicatorPanel({
  enabled,
  onEnabledChange,
  params,
  onParamsChange,
  style,
  onStyleChange,
  stats,
  loading,
  error,
}: IndicatorPanelProps) {
  const [open, setOpen] = useState(false);

  // Raw text while typing, so "0." and a half-typed "20" stay editable.
  const [drafts, setDrafts] = useState<Record<NumericKey, string>>({
    thresholdPips: String(params.thresholdPips),
    thresholdPercent: String(params.thresholdPercent),
    atrPeriod: String(params.atrPeriod),
    atrMultiple: String(params.atrMultiple),
    manualPip: String(params.manualPip),
    maxDays: String(params.maxDays),
    minGap: String(params.minGap),
  });

  // Refs, not render-time reads: the debounce timer fires long after the
  // render that scheduled it and must merge onto the newest params.
  const paramsRef = useRef(params);
  const pendingRef = useRef<Partial<BigBodyParams>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const patchParams = (patch: Partial<BigBodyParams>) => {
    onParamsChange({ ...paramsRef.current, ...patch });
  };

  const commitNumber = (key: NumericKey, raw: string) => {
    setDrafts((previous) => ({ ...previous, [key]: raw }));
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value)) return;

    pendingRef.current = { ...pendingRef.current, [key]: value };
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const patch = pendingRef.current;
      pendingRef.current = {};
      onParamsChange({ ...paramsRef.current, ...patch });
    }, COMMIT_DELAY_MS);
  };

  return (
    <div className="pointer-events-auto absolute right-2 top-2 z-30 w-[300px] rounded-md border border-term-border bg-term-panel/95 shadow-lg shadow-black/40 backdrop-blur-[1px]">
      <div className="flex items-center gap-1.5 border-b border-term-border px-2 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex flex-1 items-center gap-1.5 text-left text-small font-semibold tracking-[0.01em] text-term-dim transition-colors hover:text-term-text"
        >
          <span
            aria-hidden
            className={`text-micro transition-transform ${open ? 'rotate-90' : ''}`}
          >
            ▶
          </span>
          Big Body
        </button>

        {enabled && loading ? (
          <span aria-hidden className="h-1.5 w-1.5 animate-pulse bg-term-accent" />
        ) : null}

        <label className="flex cursor-pointer items-center gap-1">
          <span className="sr-only">Enable Big Body indicator</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
            className={CHECKBOX}
          />
        </label>
      </div>

      {enabled && stats !== null ? (
        <div className="border-b border-term-border px-2 py-1.5">
          <div className="grid grid-cols-4 gap-x-2 gap-y-1">
            <Stat label="big" value={stats.bigCandles} />
            <Stat label="touch" value={stats.touched} />
            <Stat label="exp" value={stats.expired} />
            <Stat label="pend" value={stats.pending} />
          </div>
          {stats.truncated ? (
            <p className="mt-1 text-tiny text-term-accent">
              Pine object cap — showing most recent {PINE_MAX_OBJECTS}
            </p>
          ) : null}
        </div>
      ) : null}

      {enabled && error !== null ? (
        <p className="border-b border-term-border px-2 py-1.5 font-mono text-tiny text-term-down">
          indicator unavailable — {error}
        </p>
      ) : null}

      {open ? (
        <div className="max-h-[62vh] overflow-y-auto overscroll-contain px-2 py-1.5">
          <div className="py-[3px]">
            <span className={LABEL}>Threshold rule</span>
            <div
              role="group"
              aria-label="Threshold rule"
              className="mt-1 flex rounded-md border border-term-border"
            >
              {THRESHOLD_MODES.map((mode) => {
                const active = params.thresholdMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => patchParams({ thresholdMode: mode })}
                    className={`flex-1 border-r border-term-border px-1 py-[5px] text-small tracking-[0.01em] transition-colors last:border-r-0 ${
                      active
                        ? 'bg-term-accent/20 text-term-accent'
                        : 'text-term-dim hover:text-term-text'
                    }`}
                  >
                    {THRESHOLD_MODE_LABELS[mode]}
                    {mode === 'pips' ? (
                      <span className="ml-0.5 text-micro text-term-muted">•</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-tiny text-term-muted">
              Pips (•) is the Pine default. A fixed pip threshold does not
              survive a price regime: gold ran 1800 → 4400, so $20 was 1.12% of
              price in 2021 and 0.44% in 2026 — H1 hits per year 3, 16, 13, 30,
              222, 587. Percent and ATR scale with price instead.
            </p>
          </div>

          <div className="my-1 h-px bg-term-border" />

          {params.thresholdMode === 'pips' ? (
            <>
              <label className={ROW}>
                <span className={LABEL}>Body threshold (pips)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={drafts.thresholdPips}
                  onChange={(event) =>
                    commitNumber('thresholdPips', event.target.value)
                  }
                  className={NUMBER_INPUT}
                />
              </label>

              {/* Pip size only means anything in `pips` mode: percent and ATR
                  never divide the body by it, so these two are not rendered
                  at all elsewhere rather than left to be set to no effect. */}
              <label className={ROW}>
                <span className={LABEL}>Auto pip size (mintick x 10)</span>
                <input
                  type="checkbox"
                  checked={params.autoPip}
                  onChange={(event) => patchParams({ autoPip: event.target.checked })}
                  className={CHECKBOX}
                />
              </label>

              <label className={ROW}>
                <span className={LABEL}>Manual pip size</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.001"
                  min={0}
                  value={drafts.manualPip}
                  onChange={(event) => commitNumber('manualPip', event.target.value)}
                  className={NUMBER_INPUT}
                />
              </label>
            </>
          ) : null}

          {params.thresholdMode === 'percent' ? (
            <label className={ROW}>
              <span className={LABEL}>Body threshold (% of close)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0.1}
                value={drafts.thresholdPercent}
                onChange={(event) =>
                  commitNumber('thresholdPercent', event.target.value)
                }
                className={NUMBER_INPUT}
              />
            </label>
          ) : null}

          {params.thresholdMode === 'atr' ? (
            <>
              <label className={ROW}>
                <span className={LABEL}>ATR period</span>
                <input
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min={1}
                  value={drafts.atrPeriod}
                  onChange={(event) => commitNumber('atrPeriod', event.target.value)}
                  className={NUMBER_INPUT}
                />
              </label>

              <label className={ROW}>
                <span className={LABEL}>ATR multiple</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  min={0.1}
                  value={drafts.atrMultiple}
                  onChange={(event) => commitNumber('atrMultiple', event.target.value)}
                  className={NUMBER_INPUT}
                />
              </label>
            </>
          ) : null}

          <div className="my-1 h-px bg-term-border" />

          <label className={ROW}>
            <span className={LABEL}>Frame whole candle</span>
            <input
              type="checkbox"
              checked={params.frameFull}
              onChange={(event) => patchParams({ frameFull: event.target.checked })}
              className={CHECKBOX}
            />
          </label>

          <label className={ROW}>
            <span className={LABEL}>Show pip label</span>
            <input
              type="checkbox"
              checked={params.showLabel}
              onChange={(event) => patchParams({ showLabel: event.target.checked })}
              className={CHECKBOX}
            />
          </label>

          <label className="flex flex-col gap-1 py-[3px]">
            <span className={LABEL}>Level(s) to track</span>
            <select
              value={params.levelMode}
              onChange={(event) => {
                const value = event.target.value;
                if (isLevelMode(value)) patchParams({ levelMode: value });
              }}
              className="h-[26px] w-full rounded-md border border-term-border bg-term-bg px-1.5 text-small text-term-text outline-none focus:border-term-accent"
            >
              {LEVEL_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>

          <label className={ROW}>
            <span className={LABEL}>Stop projecting after (days)</span>
            <input
              type="number"
              inputMode="numeric"
              value={drafts.maxDays}
              onChange={(event) => commitNumber('maxDays', event.target.value)}
              className={NUMBER_INPUT}
            />
          </label>

          <label className={ROW}>
            <span className={LABEL}>Show pending lines</span>
            <input
              type="checkbox"
              checked={style.showPending}
              onChange={(event) =>
                onStyleChange({ ...style, showPending: event.target.checked })
              }
              className={CHECKBOX}
            />
          </label>

          <label className={ROW}>
            <span className={LABEL}>Min bars before a touch counts</span>
            <input
              type="number"
              inputMode="numeric"
              value={drafts.minGap}
              onChange={(event) => commitNumber('minGap', event.target.value)}
              className={NUMBER_INPUT}
            />
          </label>

          <div className="my-1 h-px bg-term-border" />

          <ColorInput
            label="Border colour"
            value={style.borderCol}
            onChange={(borderCol) => onStyleChange({ ...style, borderCol })}
          />
          <ColorInput
            label="Pending colour"
            value={style.pendingCol}
            onChange={(pendingCol) => onStyleChange({ ...style, pendingCol })}
          />
          <ColorInput
            label="Touched colour"
            value={style.touchedCol}
            onChange={(touchedCol) => onStyleChange({ ...style, touchedCol })}
          />

          <label className={ROW}>
            <span className={LABEL}>Border width</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={8}
              value={style.borderWidth}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value >= 1) {
                  onStyleChange({ ...style, borderWidth: value });
                }
              }}
              className={NUMBER_INPUT}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
