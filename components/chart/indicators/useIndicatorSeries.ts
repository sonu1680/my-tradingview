'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar } from '@/lib/candles/types';
import {
  colorOf,
  computeInstance,
  indicatorDef,
  toColumns,
  type IndicatorInstance,
} from '@/lib/indicators/catalog';

/**
 * Owns the lightweight-charts series for every user-added indicator.
 *
 * ## Why the layout is rebuilt wholesale
 *
 * Panes in lightweight-charts are addressed by INDEX, and removing pane 1
 * renumbers every pane above it. Incrementally reconciling that is where the
 * subtle bugs live — an RSI quietly drawing into the MACD's pane. So any change
 * to the SET or ORDER of instances tears every indicator series down and
 * rebuilds it; that happens only when the user edits their layout, which is
 * rare and instantaneous at this scale.
 *
 * The frequent paths are deliberately cheap:
 *  - new bars (replay stepping, scroll-back) → `setData` on existing series
 *  - a period, colour or width change → `setData` / `applyOptions` in place
 *
 * ## The NaN contract
 *
 * `lib/indicators/ta.ts` marks undefined readings as NaN. Those points are
 * OMITTED from the series rather than sent as 0, so a warm-up window leaves a
 * gap in the line instead of drawing a false flat run along zero.
 */

/** Per-instance record of what we created, so teardown is exact. */
interface Mounted {
  instanceId: string;
  /** Plot key -> its series. */
  series: Map<string, ISeriesApi<SeriesType, Time>>;
  priceLines: IPriceLine[];
  paneIndex: number;
}

function asUtc(seconds: number): UTCTimestamp {
  return seconds as UTCTimestamp;
}

/** Pane 0 is the candles; oscillators start at 1. */
const PRICE_PANE = 0;

/** Share of the chart one oscillator pane gets, when there is room for it. */
const PANE_SHARE = 0.19;
/** The most of the chart all oscillator panes together may take. */
const MAX_OSCILLATOR_SHARE = 0.66;

export type IndicatorValues = Map<string, Record<string, Float64Array>>;

/**
 * The computed columns for every instance, recomputed only when the bars or
 * the instances actually change.
 *
 * Shared with the legend so the numbers under the crosshair are literally the
 * ones being drawn, not a second computation that could drift from them.
 */
export function useIndicatorValues(
  bars: readonly Bar[] | undefined,
  instances: readonly IndicatorInstance[],
): IndicatorValues {
  return useMemo(() => {
    const out: IndicatorValues = new Map();
    if (bars === undefined || bars.length === 0) return out;
    // One transpose for the whole set rather than one per indicator.
    const columns = toColumns(bars);
    for (const instance of instances) {
      try {
        out.set(instance.instanceId, computeInstance(instance, columns));
      } catch (error) {
        // One malformed instance must not blank the whole chart.
        console.warn(`[indicators] ${instance.id} failed to compute`, error);
        out.set(instance.instanceId, {});
      }
    }
    return out;
  }, [bars, instances]);
}

function toLineData(time: Float64Array, values: Float64Array): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    // Skip, never substitute. See the NaN contract above.
    if (!Number.isFinite(value)) continue;
    out.push({ time: asUtc(time[i]), value });
  }
  return out;
}

function toHistogramData(
  time: Float64Array,
  values: Float64Array,
  color: string,
): HistogramData<Time>[] {
  const out: HistogramData<Time>[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    out.push({
      time: asUtc(time[i]),
      value,
      // Above/below zero reads at a glance; the alpha keeps it behind the lines.
      color: value >= 0 ? `${color}cc` : `${color}66`,
    });
  }
  return out;
}

interface Options {
  chartRef: RefObject<IChartApi | null>;
  instances: readonly IndicatorInstance[];
  bars: readonly Bar[] | undefined;
  values: IndicatorValues;
  /** Decimals for price-pane indicators, so an EMA matches the price axis. */
  pricePrecision: number;
}

export function useIndicatorSeries({
  chartRef,
  instances,
  bars,
  values,
  pricePrecision,
}: Options): void {
  const mountedRef = useRef<Mounted[]>([]);

  /**
   * Identity of the LAYOUT, not of the settings.
   *
   * Only the things that decide which series exist and which pane they live in:
   * the ordered list of instances and their types. A period or colour change
   * leaves this untouched and takes the cheap in-place path below.
   */
  const layoutKey = useMemo(
    () => instances.map((instance) => `${instance.instanceId}:${instance.id}`).join('|'),
    [instances],
  );

  /* ---- build / rebuild the series set ---- */
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;

    const mounted: Mounted[] = [];
    let nextPane = PRICE_PANE;

    for (const instance of instances) {
      const def = indicatorDef(instance.id);
      let paneIndex = PRICE_PANE;

      if (def.pane === 'separate') {
        nextPane += 1;
        paneIndex = nextPane;
        // addSeries with an index past the end does not reliably create the
        // intervening panes, so make them explicitly.
        while (chart.panes().length <= paneIndex) chart.addPane();
      }

      const series = new Map<string, ISeriesApi<SeriesType, Time>>();
      for (const plot of def.plots) {
        const color = colorOf(instance, plot);
        if (plot.style === 'histogram') {
          series.set(
            plot.key,
            chart.addSeries(
              HistogramSeries,
              { color, priceLineVisible: false, lastValueVisible: false },
              paneIndex,
            ),
          );
        } else {
          series.set(
            plot.key,
            chart.addSeries(
              LineSeries,
              {
                color,
                lineWidth: 2,
                lineStyle: plot.style === 'dashed' ? LineStyle.Dashed : LineStyle.Solid,
                priceLineVisible: false,
                // The legend already prints every value; axis labels for four
                // stacked overlays would bury the price itself.
                lastValueVisible: false,
                crosshairMarkerVisible: false,
              },
              paneIndex,
            ),
          );
        }
      }

      // Reference levels (RSI 30/70, MACD zero) hang off the first plot, so
      // they inherit that pane's scale.
      const priceLines: IPriceLine[] = [];
      const anchor = series.get(def.plots[0].key);
      if (anchor !== undefined && def.levels !== undefined) {
        for (const level of def.levels) {
          priceLines.push(
            anchor.createPriceLine({
              price: level.value,
              color: level.color,
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: false,
              title: '',
            }),
          );
        }
      }

      mounted.push({ instanceId: instance.instanceId, series, priceLines, paneIndex });
    }

    /*
     * Size the panes by STRETCH FACTOR, not by height.
     *
     * `setHeight` is a trap here: it re-scales every other pane to absorb the
     * change, so sizing panes one after another leaves whichever was set first
     * (or last, depending on direction) crushed to ~25px. Stretch factors are
     * relative weights applied together, so one pass gives exactly the layout
     * asked for, at any chart height and with no iteration.
     */
    const panes = chart.panes();
    const oscillators = mounted
      .map((entry) => entry.paneIndex)
      .filter((index) => index > PRICE_PANE);

    if (oscillators.length > 0) {
      // However many are stacked, the candles keep at least a third of the
      // chart — they are what is actually being read.
      const each = Math.min(PANE_SHARE, MAX_OSCILLATOR_SHARE / oscillators.length);
      panes[PRICE_PANE]?.setStretchFactor(1 - each * oscillators.length);
      for (const index of oscillators) panes[index]?.setStretchFactor(each);
    }

    mountedRef.current = mounted;

    return () => {
      // The chart may already be gone (unmount order); removing a series from a
      // removed chart throws, so every call is guarded.
      for (const entry of mounted) {
        for (const series of entry.series.values()) {
          try {
            chart.removeSeries(series);
          } catch {
            // Already disposed with the chart.
          }
        }
      }
      // Highest index first: removing a pane renumbers the ones above it.
      for (let index = chart.panes().length - 1; index >= 1; index -= 1) {
        try {
          chart.removePane(index);
        } catch {
          // Already disposed with the chart.
        }
      }
      mountedRef.current = [];
    };
  }, [chartRef, layoutKey, instances]);

  /* ---- push data and styling (the frequent path) ---- */
  useEffect(() => {
    if (bars === undefined) return;
    const time = new Float64Array(bars.length);
    for (let i = 0; i < bars.length; i += 1) time[i] = bars[i].time;

    for (const instance of instances) {
      const entry = mountedRef.current.find(
        (candidate) => candidate.instanceId === instance.instanceId,
      );
      if (entry === undefined) continue;
      const def = indicatorDef(instance.id);
      const computed = values.get(instance.instanceId) ?? {};

      for (const plot of def.plots) {
        const series = entry.series.get(plot.key);
        if (series === undefined) continue;
        const color = colorOf(instance, plot);

        if (plot.style === 'histogram') {
          series.applyOptions({ visible: instance.visible });
          series.setData(
            instance.visible && computed[plot.key] !== undefined
              ? toHistogramData(time, computed[plot.key], color)
              : [],
          );
          continue;
        }

        series.applyOptions({
          color,
          // A dashed basis line stays 1px however thick the bands are: it is a
          // reference, not a level to trade.
          lineWidth: (plot.style === 'dashed' ? 1 : instance.lineWidth) as 1 | 2 | 3 | 4,
          visible: instance.visible,
          ...(def.pane === 'price'
            ? {
                priceFormat: {
                  type: 'price' as const,
                  precision: pricePrecision,
                  minMove: 1 / 10 ** pricePrecision,
                },
              }
            : {}),
        });
        series.setData(
          instance.visible && computed[plot.key] !== undefined
            ? toLineData(time, computed[plot.key])
            : [],
        );
      }
    }
  }, [instances, values, bars, pricePrecision]);
}
