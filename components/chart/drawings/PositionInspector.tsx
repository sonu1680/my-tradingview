'use client';

import { useEffect, useRef, useState } from 'react';
import { positionMetrics } from '@/lib/drawings/geometry';
import {
  XAUUSD_CONTRACT_SIZE,
  type PositionDrawing,
} from '@/lib/drawings/types';

interface PositionInspectorProps {
  position: PositionDrawing;
  onChange: (position: PositionDrawing) => void;
  /**
   * Per-keystroke writes. They land on the chart immediately but are not
   * undoable on their own: the whole edit of one field is one step, bracketed
   * by `onEditStart` / `onEditEnd`. Without these the component behaves as it
   * always did and every keystroke goes through `onChange`.
   */
  onTransientChange?: (position: PositionDrawing) => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
  onDelete: () => void;
  onClose: () => void;
}

type Field = 'entry' | 'stop' | 'target' | 'lots' | 'width';

/**
 * Narrowest the box may be set to, in minutes.
 *
 * Mirrors `MIN_POSITION_WIDTH_SECONDS` in `lib/drawings/geometry.ts`, which
 * clamps the same thing when the edge is dragged instead of typed.
 */
const MIN_WIDTH_MINUTES = 1;

/** The box's horizontal span, in whole minutes. */
const widthMinutes = (position: PositionDrawing): number =>
  Math.max(MIN_WIDTH_MINUTES, Math.round((position.endTime - position.time) / 60));

const FIELD_INPUT =
  'h-[26px] w-[92px] shrink-0 rounded-md border border-term-border bg-term-bg px-1.5 text-right font-mono text-small tabular-nums text-term-text outline-none focus:border-term-accent';

function money(value: number): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pips(value: number): string {
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} pips`;
}

/** Says plainly what is wrong, instead of printing a negative R:R. */
function problems(position: PositionDrawing): string[] {
  const { side, entry, stop, target } = position;
  const list: string[] = [];
  if (side === 'long') {
    if (stop >= entry) list.push('stop is above entry on a long');
    if (target <= entry) list.push('target is below entry on a long');
  } else {
    if (stop <= entry) list.push('stop is below entry on a short');
    if (target >= entry) list.push('target is above entry on a short');
  }
  return list;
}

export default function PositionInspector({
  position,
  onChange,
  onTransientChange,
  onEditStart,
  onEditEnd,
  onDelete,
  onClose,
}: PositionInspectorProps) {
  // Raw text only while a field is focused, so "17" on the way to "1750" and a
  // trailing "." stay editable. Unfocused fields always show the live value,
  // which is what makes the readout track a handle drag.
  const [drafts, setDrafts] = useState<Partial<Record<Field, string>>>({});
  // Whether THIS component has an edit step open. Closing one it never opened
  // would eat the commit of whatever else is mid-gesture.
  const editingRef = useRef(false);

  // Deselecting or deleting unmounts the panel with a field still focused, and
  // no blur is fired for that; the step would otherwise stay open forever.
  useEffect(
    () => () => {
      if (!editingRef.current) return;
      editingRef.current = false;
      onEditEnd?.();
    },
    [onEditEnd],
  );

  const metrics = positionMetrics(position);
  const reasons = metrics.invalid ? problems(position) : [];

  const commit = (field: Field, raw: string) => {
    setDrafts((previous) => ({ ...previous, [field]: raw }));
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value)) return;
    if (field === 'lots' && value <= 0) return;

    // Width is stored as a pair of timestamps, not as a duration, so it is the
    // one field that is not a straight assignment. The start is held fixed and
    // the end moves, which is what dragging the right edge does too.
    let next: PositionDrawing;
    if (field === 'width') {
      const minutes = Math.max(MIN_WIDTH_MINUTES, Math.round(value));
      next = { ...position, endTime: position.time + minutes * 60 };
    } else {
      next = { ...position, [field]: value };
    }
    // Typing "4350" is four changes; one undo must take all four back.
    if (onTransientChange !== undefined) onTransientChange(next);
    else onChange(next);
  };

  const focus = () => {
    if (editingRef.current) return;
    editingRef.current = true;
    onEditStart?.();
  };

  const blur = (field: Field) => {
    setDrafts((previous) => {
      if (previous[field] === undefined) return previous;
      const next = { ...previous };
      delete next[field];
      return next;
    });
    // `blur` always precedes the next field's `focus`, so moving between
    // fields closes one step and opens the next.
    if (!editingRef.current) return;
    editingRef.current = false;
    onEditEnd?.();
  };

  const priceField = (field: Exclude<Field, 'lots' | 'width'>, label: string, tint: string) => (
    <label className="flex items-center justify-between gap-2 py-[3px]">
      <span className={`text-small ${tint}`}>{label}</span>
      <input
        type="number"
        step="0.01"
        inputMode="decimal"
        value={drafts[field] ?? String(position[field])}
        onChange={(event) => commit(field, event.target.value)}
        onFocus={focus}
        onBlur={() => blur(field)}
        className={FIELD_INPUT}
      />
    </label>
  );

  return (
    <div className="pointer-events-auto absolute bottom-2 right-2 z-30 w-[300px] rounded-md border border-term-border bg-term-panel/95 shadow-lg shadow-black/40 backdrop-blur-[1px]">
      <div className="flex items-center gap-1.5 border-b border-term-border px-2 py-1.5">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 ${
            position.side === 'long' ? 'bg-term-up' : 'bg-term-down'
          }`}
        />
        <span className="flex-1 text-small font-semibold tracking-[0.01em] text-term-dim">
          {position.side} position
        </span>
        <button
          type="button"
          title="Delete this position (Del)"
          onClick={onDelete}
          className="px-1 text-small text-term-muted transition-colors hover:text-term-down"
        >
          del
        </button>
        <button
          type="button"
          title="Deselect (Esc)"
          onClick={onClose}
          className="px-1 text-body text-term-muted transition-colors hover:text-term-text"
        >
          ✕
        </button>
      </div>

      <div className="px-2 py-1.5">
        {priceField('entry', 'Entry', 'text-term-dim')}
        {priceField('stop', 'Stop', 'text-term-down')}
        {priceField('target', 'Target', 'text-term-up')}
        <label className="flex items-center justify-between gap-2 py-[3px]">
          <span className="text-small text-term-dim">
            Lots
            <span className="ml-1 text-tiny text-term-muted">
              ({XAUUSD_CONTRACT_SIZE} oz/lot)
            </span>
          </span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            inputMode="decimal"
            value={drafts.lots ?? String(position.lots)}
            onChange={(event) => commit('lots', event.target.value)}
            onFocus={focus}
            onBlur={() => blur('lots')}
            className={FIELD_INPUT}
          />
        </label>
        <label className="flex items-center justify-between gap-2 py-[3px]">
          <span className="text-small text-term-dim">
            Width
            <span className="ml-1 text-tiny text-term-muted">(minutes)</span>
          </span>
          <input
            type="number"
            step="1"
            min={MIN_WIDTH_MINUTES}
            inputMode="numeric"
            value={drafts.width ?? String(widthMinutes(position))}
            onChange={(event) => commit('width', event.target.value)}
            onFocus={focus}
            onBlur={() => blur('width')}
            className={FIELD_INPUT}
          />
        </label>
      </div>

      <div className="border-t border-term-border px-2 py-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-tiny tracking-[0.01em] text-term-muted">
            Risk : Reward
          </span>
          <span className="font-mono text-head tabular-nums text-term-text">
            {/* A reversed setup would otherwise read as a healthy ratio. */}
            {metrics.rr === null || metrics.invalid
              ? '—'
              : `1 : ${metrics.rr.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`}
          </span>
        </div>

        <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5">
          <span className="text-tiny tracking-[0.01em] text-term-down">
            Risk
          </span>
          <span className="text-tiny tracking-[0.01em] text-term-up">
            Reward
          </span>
          <span className="font-mono text-body tabular-nums text-term-down">
            {money(metrics.riskUsd)}
          </span>
          <span className="font-mono text-body tabular-nums text-term-up">
            {money(metrics.rewardUsd)}
          </span>
          <span className="font-mono text-small tabular-nums text-term-muted">
            {pips(metrics.riskPips)}
          </span>
          <span className="font-mono text-small tabular-nums text-term-muted">
            {pips(metrics.rewardPips)}
          </span>
        </div>

        {metrics.invalid ? (
          <p className="mt-1.5 border-t border-term-border pt-1.5 text-tiny text-term-accent">
            {reasons.length > 0
              ? reasons.join(' · ')
              : 'stop and entry are the same price'}
          </p>
        ) : null}
      </div>
    </div>
  );
}
