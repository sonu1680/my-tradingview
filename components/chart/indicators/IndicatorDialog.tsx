'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CATALOG_GROUPS,
  MAX_INDICATORS,
  SOURCES,
  SOURCE_LABELS,
  createInstance,
  indicatorDef,
  instanceLabel,
  paramOf,
  type IndicatorId,
  type IndicatorInstance,
  type Source,
} from '@/lib/indicators/catalog';

/**
 * The indicator manager: a catalog to add from, and the active list to tune.
 *
 * One dialog rather than a picker plus a separate settings popover, because
 * tuning an indicator is nearly always followed by tuning another one, and a
 * popover that has to track a legend row through a chart pan is fragile for no
 * benefit.
 */

interface Props {
  onClose: () => void;
  instances: IndicatorInstance[];
  onInstancesChange: (instances: IndicatorInstance[]) => void;
  /**
   * Opened from a legend gear: that row starts expanded.
   *
   * Read once, as the initial state. The parent mounts this component only
   * while it is open and gives it a `key` that changes per opening, so a fresh
   * open always starts from the right row without an effect syncing props into
   * state — which the React Compiler lint rules reject outright, and rightly:
   * it would also fight the user collapsing the row.
   */
  focusInstanceId: string | null;
}

export default function IndicatorDialog({
  onClose,
  instances,
  onInstancesChange,
  focusInstanceId,
}: Props) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(focusInstanceId);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    // Capture: the chart's own key handlers sit on the window too, and Escape
    // here must not also clear a drawing selection underneath.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return CATALOG_GROUPS.map((group) => ({
      label: group.label,
      ids: group.ids.filter((id) => {
        if (needle.length === 0) return true;
        const def = indicatorDef(id);
        return (
          def.label.toLowerCase().includes(needle) ||
          def.short.toLowerCase().includes(needle) ||
          def.hint.toLowerCase().includes(needle)
        );
      }),
    })).filter((group) => group.ids.length > 0);
  }, [query]);

  const atCapacity = instances.length >= MAX_INDICATORS;

  const add = (id: IndicatorId) => {
    if (atCapacity) return;
    const instance = createInstance(id);
    onInstancesChange([...instances, instance]);
    setExpanded(instance.instanceId);
  };

  const update = (instanceId: string, patch: Partial<IndicatorInstance>) => {
    onInstancesChange(
      instances.map((instance) =>
        instance.instanceId === instanceId ? { ...instance, ...patch } : instance,
      ),
    );
  };

  const remove = (instanceId: string) => {
    onInstancesChange(instances.filter((i) => i.instanceId !== instanceId));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Indicators"
        aria-modal="true"
        className="flex h-[min(620px,88vh)] w-[min(880px,94vw)] flex-col rounded-xl border border-term-border bg-term-raised shadow-2xl shadow-black/70 ring-1 ring-white/[0.04]"
      >
        <header className="flex items-center gap-3 border-b border-term-border px-5 py-3.5">
          <h2 className="text-head font-semibold tracking-wide text-term-text">
            Indicators
          </h2>
          <span className="font-mono text-tiny tabular-nums text-term-muted">
            {instances.length}/{MAX_INDICATORS}
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

        <div className="grid min-h-0 flex-1 grid-cols-[1fr_1.15fr]">
          {/* ---- catalog ---- */}
          <section className="flex min-h-0 flex-col border-r border-term-border">
            <div className="px-3 py-2.5">
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search indicators…"
                className="w-full rounded-md border border-term-border bg-term-bg px-2.5 py-1.5 text-body text-term-text outline-none transition-colors placeholder:text-term-muted focus:border-term-accent/60"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {groups.length === 0 ? (
                <p className="px-1 py-6 text-center text-small text-term-muted">
                  Nothing matches “{query}”.
                </p>
              ) : null}

              {groups.map((group) => (
                <div key={group.label} className="mb-3">
                  <p className="mb-1 px-1 text-micro tracking-[0.01em] text-term-muted">
                    {group.label}
                  </p>
                  <ul className="flex flex-col">
                    {group.ids.map((id) => {
                      const def = indicatorDef(id);
                      return (
                        <li key={id}>
                          <button
                            type="button"
                            onClick={() => add(id)}
                            disabled={atCapacity}
                            className="group flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-term-border-strong hover:bg-term-bg disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <span className="flex-1">
                              <span className="block text-body text-term-text">
                                {def.label}
                              </span>
                              <span className="block text-tiny leading-snug text-term-muted">
                                {def.hint}
                              </span>
                            </span>
                            <span className="mt-0.5 shrink-0 text-lead leading-none text-term-muted transition-colors group-hover:text-term-accent">
                              +
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>

            {atCapacity ? (
              <p className="border-t border-term-border px-3 py-2 text-tiny text-term-accent">
                {MAX_INDICATORS} indicators is the limit — remove one to add another.
              </p>
            ) : null}
          </section>

          {/* ---- active list ---- */}
          <section className="flex min-h-0 flex-col">
            <div className="flex items-center gap-2 px-3 py-2.5">
              <p className="text-micro tracking-[0.01em] text-term-muted">
                On this chart
              </p>
              {instances.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onInstancesChange([])}
                  className="ml-auto text-tiny text-term-muted underline-offset-2 transition-colors hover:text-term-down hover:underline"
                >
                  Remove all
                </button>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {instances.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
                  <p className="text-body text-term-dim">No indicators yet</p>
                  <p className="text-small text-term-muted">
                    Pick one on the left. Your layout is saved in this browser and
                    follows you across timeframes.
                  </p>
                </div>
              ) : null}

              <ul className="flex flex-col gap-1.5">
                {instances.map((instance) => (
                  <InstanceRow
                    key={instance.instanceId}
                    instance={instance}
                    expanded={expanded === instance.instanceId}
                    onToggleExpanded={() =>
                      setExpanded(expanded === instance.instanceId ? null : instance.instanceId)
                    }
                    onChange={(patch) => update(instance.instanceId, patch)}
                    onRemove={() => remove(instance.instanceId)}
                  />
                ))}
              </ul>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function InstanceRow({
  instance,
  expanded,
  onToggleExpanded,
  onChange,
  onRemove,
}: {
  instance: IndicatorInstance;
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (patch: Partial<IndicatorInstance>) => void;
  onRemove: () => void;
}) {
  const def = indicatorDef(instance.id);

  return (
    <li className="rounded-md border border-term-border bg-term-bg">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => onChange({ visible: !instance.visible })}
          title={instance.visible ? 'Hide' : 'Show'}
          aria-label={instance.visible ? 'Hide' : 'Show'}
          className={`flex h-5 w-5 items-center justify-center transition-colors ${
            instance.visible ? 'text-term-dim' : 'text-term-muted'
          } hover:text-term-text`}
        >
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{
              backgroundColor: instance.visible
                ? (instance.colors[def.plots[0].key] ?? def.plots[0].color)
                : 'transparent',
              border: `1px solid ${instance.colors[def.plots[0].key] ?? def.plots[0].color}`,
            }}
          />
        </button>

        <button
          type="button"
          onClick={onToggleExpanded}
          className="flex flex-1 items-baseline gap-2 text-left"
        >
          <span
            className={`font-mono text-body ${
              instance.visible ? 'text-term-text' : 'text-term-muted line-through'
            }`}
          >
            {instanceLabel(instance)}
          </span>
          <span className="text-tiny text-term-muted">{def.label}</span>
        </button>

        <button
          type="button"
          onClick={onToggleExpanded}
          aria-label={expanded ? 'Collapse settings' : 'Expand settings'}
          className="flex h-5 w-5 items-center justify-center text-term-muted transition-colors hover:text-term-text"
        >
          <svg
            viewBox="0 0 16 16" width="12" height="12" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            strokeLinejoin="round" aria-hidden
            style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          className="flex h-5 w-5 items-center justify-center text-term-muted transition-colors hover:text-term-down"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {expanded ? (
        <div className="flex flex-col gap-2.5 border-t border-term-border px-2.5 py-2.5">
          {def.inputs.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {def.inputs.map((input) => (
                <NumberField
                  key={input.key}
                  label={input.label}
                  value={paramOf(def, instance.params, input.key)}
                  min={input.min}
                  max={input.max}
                  step={input.step}
                  onChange={(next) =>
                    onChange({ params: { ...instance.params, [input.key]: next } })
                  }
                />
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-end gap-3">
            {def.hasSource ? (
              <label className="flex flex-col gap-1">
                <span className="text-micro tracking-[0.01em] text-term-muted">
                  Source
                </span>
                <select
                  value={instance.source}
                  onChange={(event) =>
                    onChange({ source: event.target.value as Source })
                  }
                  className="rounded-md border border-term-border bg-term-panel px-1.5 py-1 font-mono text-small text-term-text outline-none focus:border-term-accent/60"
                >
                  {SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {SOURCE_LABELS[source]}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="flex flex-col gap-1">
              <span className="text-micro tracking-[0.01em] text-term-muted">
                Width
              </span>
              <select
                value={instance.lineWidth}
                onChange={(event) =>
                  onChange({ lineWidth: Number(event.target.value) })
                }
                className="rounded-md border border-term-border bg-term-panel px-1.5 py-1 font-mono text-small text-term-text outline-none focus:border-term-accent/60"
              >
                {[1, 2, 3, 4].map((width) => (
                  <option key={width} value={width}>
                    {width}px
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-micro tracking-[0.01em] text-term-muted">
                Colours
              </span>
              <div className="flex items-center gap-2">
                {def.plots.map((plot) => (
                  <label
                    key={plot.key}
                    title={plot.label}
                    className="flex cursor-pointer items-center gap-1"
                  >
                    <input
                      type="color"
                      value={instance.colors[plot.key] ?? plot.color}
                      onChange={(event) =>
                        onChange({
                          colors: { ...instance.colors, [plot.key]: event.target.value },
                        })
                      }
                      className="h-5 w-5 cursor-pointer rounded-md border border-term-border bg-transparent p-0"
                    />
                    <span className="text-tiny text-term-muted">{plot.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * A numeric field that stays usable mid-typing.
 *
 * The input keeps its own text while focused, so clearing it to type a new
 * number does not momentarily snap the value to the minimum and redraw the
 * chart at period 1.
 */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? String(value);

  const commit = (raw: string) => {
    setText(null);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.min(max, Math.max(min, parsed)));
  };

  const nudge = (direction: 1 | -1) => {
    setText(null);
    const next = Number((value + direction * step).toFixed(4));
    onChange(Math.min(max, Math.max(min, next)));
  };

  return (
    <label className="flex flex-col gap-1">
      <span className="text-micro tracking-[0.01em] text-term-muted">
        {label}
      </span>
      <span className="flex items-stretch rounded-md border border-term-border">
        <button
          type="button"
          onClick={() => nudge(-1)}
          aria-label={`Decrease ${label}`}
          className="w-5 text-term-muted transition-colors hover:bg-term-border hover:text-term-text"
        >
          −
        </button>
        <input
          value={shown}
          inputMode="decimal"
          onChange={(event) => setText(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(event.currentTarget.value);
            if (event.key === 'Escape') setText(null);
            // Arrows would otherwise reach the chart and pan it.
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              nudge(event.key === 'ArrowUp' ? 1 : -1);
            }
            event.stopPropagation();
          }}
          className="w-14 bg-term-panel px-1 py-1 text-center font-mono text-small tabular-nums text-term-text outline-none focus:bg-term-bg"
        />
        <button
          type="button"
          onClick={() => nudge(1)}
          aria-label={`Increase ${label}`}
          className="w-5 text-term-muted transition-colors hover:bg-term-border hover:text-term-text"
        >
          +
        </button>
      </span>
    </label>
  );
}
