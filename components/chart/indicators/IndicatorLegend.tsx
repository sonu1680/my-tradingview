'use client';

import {
  colorOf,
  indicatorDef,
  instanceLabel,
  type IndicatorInstance,
} from '@/lib/indicators/catalog';
import type { IndicatorValues } from './useIndicatorSeries';

/**
 * The on-chart indicator legend.
 *
 * One row per active indicator, showing the value AT THE CROSSHAIR — which is
 * the only reading a backtester cares about, since they are looking at a bar in
 * the past, not the live tail. With no crosshair it falls back to the last bar.
 *
 * The numbers come from the same computed columns the series were drawn from
 * (`IndicatorValues`), never a second computation, so the legend can never
 * disagree with the line on screen.
 */

interface Props {
  instances: readonly IndicatorInstance[];
  values: IndicatorValues;
  /** Index into the bar page under the crosshair, or null for the last bar. */
  index: number | null;
  pricePrecision: number;
  onToggleVisible: (instanceId: string) => void;
  onRemove: (instanceId: string) => void;
  onConfigure: (instanceId: string) => void;
}

function format(value: number | undefined, decimals: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export default function IndicatorLegend({
  instances,
  values,
  index,
  pricePrecision,
  onToggleVisible,
  onRemove,
  onConfigure,
}: Props) {
  if (instances.length === 0) return null;

  return (
    <div className="pointer-events-none absolute left-2 top-[52px] z-10 flex flex-col gap-px">
      {instances.map((instance) => {
        const def = indicatorDef(instance.id);
        const computed = values.get(instance.instanceId) ?? {};
        const decimals = def.pane === 'price' ? pricePrecision : (def.precision ?? 2);

        return (
          <div
            key={instance.instanceId}
            className="group pointer-events-auto flex w-fit items-center gap-2 rounded-sm bg-term-bg/70 px-1.5 py-0.5 backdrop-blur-[2px] transition-colors hover:bg-term-panel/90"
          >
            <span
              className={`font-mono text-micro tracking-wide ${
                instance.visible ? 'text-term-dim' : 'text-term-muted line-through'
              }`}
            >
              {instanceLabel(instance)}
            </span>

            {instance.visible
              ? def.plots.map((plot) => {
                  const column = computed[plot.key];
                  const at =
                    column === undefined
                      ? undefined
                      : column[index ?? column.length - 1];
                  return (
                    <span
                      key={plot.key}
                      className="flex items-center gap-1 font-mono text-micro tabular-nums"
                      title={plot.label}
                    >
                      <span
                        aria-hidden
                        className="h-[2px] w-2.5 rounded-full"
                        style={{ backgroundColor: colorOf(instance, plot) }}
                      />
                      <span style={{ color: colorOf(instance, plot) }}>
                        {format(at, decimals)}
                      </span>
                    </span>
                  );
                })
              : null}

            {/* Controls stay invisible until the row is hovered so the chart
                is not permanently cluttered with buttons. */}
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <LegendButton
                label={instance.visible ? 'Hide' : 'Show'}
                onClick={() => onToggleVisible(instance.instanceId)}
              >
                {instance.visible ? <EyeIcon /> : <EyeOffIcon />}
              </LegendButton>
              <LegendButton
                label="Settings"
                onClick={() => onConfigure(instance.instanceId)}
              >
                <GearIcon />
              </LegendButton>
              <LegendButton label="Remove" onClick={() => onRemove(instance.instanceId)}>
                <CloseIcon />
              </LegendButton>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function LegendButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-4 w-4 items-center justify-center rounded-sm text-term-muted transition-colors hover:bg-term-border hover:text-term-text"
    >
      {children}
    </button>
  );
}

/* Icons are inline so they inherit `currentColor` and need no icon package. */
const ICON = {
  viewBox: '0 0 16 16',
  width: 12,
  height: 12,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function EyeIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <path d="M1.5 8S3.9 3.5 8 3.5 14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <path d="M2.5 2.5l11 11" />
      <path d="M6.3 6.3A2 2 0 009 9.7" />
      <path d="M4.2 4.6C2.6 5.8 1.5 8 1.5 8S3.9 12.5 8 12.5c1.2 0 2.2-.3 3.1-.8" />
      <path d="M12.8 11C14 9.9 14.5 8 14.5 8S12.1 3.5 8 3.5c-.5 0-1 .1-1.4.2" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2M12.5 12.5l-1.2-1.2M4.7 4.7L3.5 3.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
