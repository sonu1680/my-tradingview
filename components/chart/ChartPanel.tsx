'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineStyle,
  PriceScaleMode,
  TickMarkType,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar, Timeframe } from '@/lib/candles/types';
import type { Drawing, DrawingStyle, ToolId } from '@/lib/drawings/types';
import type { IndicatorInstance } from '@/lib/indicators/catalog';
import type { BigBodyResult } from '@/lib/indicators/types';
import DeleteBadge, {
  DELETE_BADGE_GAP,
  DELETE_BADGE_SIZE,
} from './drawings/DeleteBadge';
import { DrawingsPrimitive } from './drawings/DrawingsPrimitive';
import { useDrawings } from './drawings/useDrawings';
import type { DrawingHistoryControls } from './drawings/useDrawingHistory';
import IndicatorLegend from './indicators/IndicatorLegend';
import {
  useIndicatorSeries,
  useIndicatorValues,
} from './indicators/useIndicatorSeries';
import OhlcLegend from './OhlcLegend';
import {
  BigBodyPrimitive,
  type BigBodyStyle,
} from './primitives/BigBodyPrimitive';
import {
  type CandleDataResult,
  formatServerClock,
  formatServerDayOfMonth,
  formatServerMonth,
  formatServerTime,
  formatServerYear,
  inferPricePrecision,
  isIntraday,
} from './useCandleData';
import { LABEL_FONT_PX, labelFontFamily } from './labelFont';

interface ChartPanelProps {
  symbol: string;
  timeframe: Timeframe;
  /**
   * The candle store, owned by the page: `useCandleData(timeframe, replayUntil)`.
   * It lives one level up because the replay controls under the header step
   * the same dataset this chart draws.
   */
  candles: CandleDataResult;
  /** Big Body shapes for this timeframe, or null when off / not loaded yet. */
  bigBody?: BigBodyResult | null;
  bigBodyStyle?: BigBodyStyle;
  /* ---- user-added studies (EMA, RSI, ...); state lives in the page ---- */
  indicators?: readonly IndicatorInstance[];
  /** Legend row controls: hide/show and remove, without opening the dialog. */
  onIndicatorsChange?: (instances: IndicatorInstance[]) => void;
  /** Legend gear: open the dialog with this row expanded. */
  onConfigureIndicator?: (instanceId: string) => void;
  /**
   * Logarithmic price axis. Over five years of gold the difference matters: on
   * a linear axis a $40 move in 2021 and in 2026 look identical, when one is
   * more than twice the other in percentage terms.
   */
  logScale?: boolean;
  /* ---- drawing tools; the state itself lives in the page ---- */
  tool: ToolId;
  onToolChange: (tool: ToolId) => void;
  drawings: Drawing[];
  onDrawingsChange: (drawings: Drawing[]) => void;
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  drawingStyle: DrawingStyle;
  /** Undo/redo, threaded straight through to the interaction hook. */
  drawingHistory?: DrawingHistoryControls | null;
}

/**
 * Candle colours: white up / blue down.
 *
 * Deliberately NOT the `--color-term-up/down` tokens — those are semantic
 * (profit/loss, risk/reward, error) and are used across the tester, the
 * position inspector and every error overlay. Price direction and "good/bad"
 * are different ideas here.
 */
const UP = '#f2f4f7';
const DOWN = '#3b82f6';
const UP_VOLUME = 'rgba(242, 244, 247, 0.34)';
const DOWN_VOLUME = 'rgba(59, 130, 246, 0.38)';
/* Canvas cannot read CSS variables, so these mirror the tokens in globals.css:
   BG = --color-term-bg, TEXT = --color-term-dim, BORDER = --color-term-border.
   GRID sits just above the background — visible, never a cage. */
const BG = '#0e1015';
const GRID = '#181b22';
const BORDER = '#252a34';
const TEXT = '#9aa2af';

/** How close to the left edge, in bars, before we page further back. */
const SCROLLBACK_TRIGGER = 50;
/** Bars visible after a fresh load / timeframe switch. */
const INITIAL_VISIBLE_BARS = 220;

/** Keep-away from the container edges when clamping the delete badge. */
const BADGE_MARGIN = 6;

/** A stable empty default, so an absent prop never re-triggers the study effects. */
const EMPTY_INDICATORS: readonly IndicatorInstance[] = [];

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2;
  return value < min ? min : value > max ? max : value;
}

function asUtc(seconds: number): UTCTimestamp {
  return seconds as UTCTimestamp;
}

/** Enough of a dataset to recognise it again; see `pushedRef`. */
interface PushedShape {
  timeframe: Timeframe;
  startIndex: number;
  length: number;
}

function toCandle(bar: Bar): CandlestickData<Time> {
  return {
    time: asUtc(bar.time),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  };
}

function toVolume(bar: Bar): HistogramData<Time> {
  return {
    time: asUtc(bar.time),
    value: bar.volume,
    color: bar.close >= bar.open ? UP_VOLUME : DOWN_VOLUME,
  };
}

/** Time axis labels. Read with UTC getters only — these are server timestamps. */
function tickMarkFormatter(time: Time, tickMarkType: TickMarkType): string | null {
  if (typeof time !== 'number') return null;
  switch (tickMarkType) {
    case TickMarkType.Year:
      return formatServerYear(time);
    case TickMarkType.Month:
      return formatServerMonth(time);
    case TickMarkType.DayOfMonth:
      return formatServerDayOfMonth(time);
    case TickMarkType.Time:
      return formatServerClock(time, false);
    case TickMarkType.TimeWithSeconds:
      return formatServerClock(time, true);
    default:
      return null;
  }
}

export default function ChartPanel({
  symbol,
  timeframe,
  candles,
  bigBody = null,
  bigBodyStyle,
  indicators = EMPTY_INDICATORS,
  onIndicatorsChange,
  onConfigureIndicator,
  logScale = false,
  tool,
  onToolChange,
  drawings,
  onDrawingsChange,
  selectedId,
  onSelectedIdChange,
  drawingStyle,
  drawingHistory = null,
}: ChartPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const bigBodyRef = useRef<BigBodyPrimitive | null>(null);
  const drawingsRef = useRef<DrawingsPrimitive | null>(null);
  const loadOlderRef = useRef<() => void>(() => {});
  const hasDataRef = useRef(false);
  /**
   * Shape of the dataset last pushed into the series, so the push effect can
   * tell "the previous data plus one bar at the tail" (replay step → cheap
   * `update()`) from every other change (→ `setData()`).
   */
  const pushedRef = useRef<PushedShape | null>(null);

  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  /** Delete-badge centre, in CSS pixels relative to the chart container. */
  const [badge, setBadge] = useState<{ x: number; y: number } | null>(null);
  /** The chart effect runs once, so its listeners reach the live recompute
   *  through this box rather than closing over a stale one. */
  const recomputeBadgeRef = useRef<() => void>(() => {});

  const { dataset, loading, loadingOlder, error, olderError, loadOlder, reload } =
    candles;

  useEffect(() => {
    loadOlderRef.current = loadOlder;
  }, [loadOlder]);

  const bars = dataset?.bars;
  const pricePrecision = useMemo(
    () => (bars !== undefined && bars.length > 0 ? inferPricePrecision(bars) : 2),
    [bars],
  );

  /** Crosshair lookup. Derived, not a ref, so the legend re-renders with data. */
  const barsByTime = useMemo(() => {
    const map = new Map<number, Bar>();
    if (bars !== undefined) {
      for (const bar of bars) map.set(bar.time, bar);
    }
    return map;
  }, [bars]);

  /**
   * Bar time -> its index in the page, so the indicator legend can read the
   * value at the crosshair. Separate from `barsByTime` because indicator
   * columns are positional, not keyed by time.
   */
  const indexByTime = useMemo(() => {
    const map = new Map<number, number>();
    if (bars !== undefined) {
      for (let i = 0; i < bars.length; i += 1) map.set(bars[i].time, i);
    }
    return map;
  }, [bars]);

  /* ---- create the chart exactly once ---- */
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: BG },
        textColor: TEXT,
        // The price and time axes are canvas text too, so they take the same
        // 13px / JetBrains Mono as the primitives' labels rather than a
        // Tailwind class.
        fontSize: LABEL_FONT_PX,
        fontFamily: labelFontFamily(),
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#5a6373',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#343b48',
        },
        horzLine: {
          color: '#5a6373',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#343b48',
        },
      },
      rightPriceScale: {
        borderColor: BORDER,
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: {
        borderColor: BORDER,
        rightOffset: 4,
        barSpacing: 7,
        minBarSpacing: 0.3,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter,
      },
      localization: {
        // Crosshair time label. UTC read, matching the "Server time" indicator.
        timeFormatter: (time: Time) =>
          typeof time === 'number' ? formatServerTime(time, true) : '',
      },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    // Volume shares the pane but lives on its own, invisible price scale so it
    // cannot squash the candles; scaleMargins park it in the bottom 20%.
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      color: UP_VOLUME,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // One primitive draws every indicator shape. It is attached once, for the
    // lifetime of the chart, and fed new shapes through setData — a timeframe
    // switch replaces the data, it never re-attaches.
    const bigBodyPrimitive = new BigBodyPrimitive();
    candle.attachPrimitive(bigBodyPrimitive);

    // Same deal for the drawings: attached once, fed state. Drawings are
    // anchored in (time, price), so a timeframe switch is a no-op for them.
    const drawingsPrimitive = new DrawingsPrimitive();
    candle.attachPrimitive(drawingsPrimitive);

    chartRef.current = chart;
    candleRef.current = candle;
    volumeRef.current = volume;
    bigBodyRef.current = bigBodyPrimitive;
    drawingsRef.current = drawingsPrimitive;

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      const time = param.time;
      setHoveredTime(typeof time === 'number' ? time : null);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    const onRangeChange = (range: LogicalRange | null) => {
      // Pan, zoom and timeframe switches all land here; re-anchor the badge on
      // the same signal the primitive repaints on. Never a timer.
      recomputeBadgeRef.current();
      if (range === null || !hasDataRef.current) return;
      if (range.from < SCROLLBACK_TRIGGER) loadOlderRef.current();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) chart.resize(width, height);
      recomputeBadgeRef.current();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      // Detach BEFORE remove(): detaching from a removed chart throws.
      candle.detachPrimitive(bigBodyPrimitive);
      candle.detachPrimitive(drawingsPrimitive);
      bigBodyRef.current = null;
      drawingsRef.current = null;
      // Mandatory: React strict mode double-invokes this effect in dev and
      // without remove() the two charts stack inside the same container.
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      hasDataRef.current = false;
      pushedRef.current = null;
    };
  }, []);

  // Declared after the chart effect so the primitive exists by the time the
  // hook's own effects run on mount.
  const { overlayRef, overlayStyle, deleteSelected, interacting } = useDrawings({
    containerRef,
    chartRef,
    primitiveRef: drawingsRef,
    tool,
    onToolChange,
    drawings,
    onDrawingsChange,
    selectedId,
    onSelectedIdChange,
    style: drawingStyle,
    history: drawingHistory,
  });

  /**
   * User-added studies.
   *
   * Computed once here and shared: `useIndicatorSeries` draws these exact
   * columns and `IndicatorLegend` reads its numbers out of the same object, so
   * the legend can never print a value the line does not have.
   */
  const indicatorValues = useIndicatorValues(bars, indicators);
  useIndicatorSeries({
    chartRef,
    instances: indicators,
    bars,
    values: indicatorValues,
    pricePrecision,
  });

  /**
   * Anchor the delete badge to the selected drawing.
   *
   * Everything here comes out of the primitive's `project()` — the same
   * projection the renderer and the hit-tester use — so the badge can never
   * drift from the pixels the user sees. Called on selection/data changes and,
   * through `recomputeBadgeRef`, on every pan, zoom and resize.
   */
  const recomputeBadge = useCallback(() => {
    const container = containerRef.current;
    const primitive = drawingsRef.current;
    if (container === null || primitive === null) {
      setBadge(null);
      return;
    }
    // Hidden while nothing is selected, and while a drag or a placement is
    // running — it would sit under the cursor and fight the gesture.
    if (selectedId === null || interacting) {
      setBadge(null);
      return;
    }

    const projected = primitive.project(drawings);
    const found = projected?.find((item) => item.drawing.id === selectedId);
    // Scrolled out of view: `project` drops drawings it cannot convert.
    if (found === undefined || found.points.length === 0) {
      setBadge(null);
      return;
    }

    const width = container.clientWidth;
    const height = container.clientHeight;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of found.points) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
    if (!Number.isFinite(minY) || !Number.isFinite(minX)) {
      setBadge(null);
      return;
    }

    // An hline's x is meaningless by contract; centre it in the chart. A
    // vline is the transpose: its x is real and its y is centred instead.
    const kind = found.drawing.kind;
    const x = kind === 'hline' ? width / 2 : (minX + maxX) / 2;

    const half = DELETE_BADGE_SIZE / 2;
    const above = minY - DELETE_BADGE_GAP - half;
    // Too close to the top edge to sit above: drop it below the shape instead.
    const y =
      kind === 'vline'
        ? height / 2
        : above - half >= BADGE_MARGIN
          ? above
          : maxY + DELETE_BADGE_GAP + half;

    setBadge({
      x: clamp(x, half + BADGE_MARGIN, width - half - BADGE_MARGIN),
      y: clamp(y, half + BADGE_MARGIN, height - half - BADGE_MARGIN),
    });
  }, [drawings, selectedId, interacting]);

  useEffect(() => {
    recomputeBadgeRef.current = recomputeBadge;
    // One frame later, not synchronously: the chart paints the new drawings on
    // its own schedule, and `project()` must read the geometry that resulted.
    const frame = requestAnimationFrame(recomputeBadge);
    return () => cancelAnimationFrame(frame);
  }, [recomputeBadge]);

  /* ---- axis + price formatting follow the timeframe ---- */
  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { timeVisible: isIntraday(timeframe) },
    });
  }, [timeframe]);

  useEffect(() => {
    chartRef.current
      ?.priceScale('right')
      .applyOptions({
        mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      });
  }, [logScale]);

  useEffect(() => {
    candleRef.current?.applyOptions({
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: 1 / 10 ** pricePrecision,
      },
    });
  }, [pricePrecision]);

  /* ---- indicator shapes and styling go through the primitive ---- */
  useEffect(() => {
    // A result computed for another timeframe must never be painted over the
    // current one; the hook already keys its responses, this is the guard for
    // the frame between a timeframe switch and the new result landing.
    bigBodyRef.current?.setData(
      bigBody !== null && bigBody.timeframe === timeframe ? bigBody : null,
    );
  }, [bigBody, timeframe]);

  useEffect(() => {
    if (bigBodyStyle !== undefined) bigBodyRef.current?.setStyle(bigBodyStyle);
  }, [bigBodyStyle]);

  /* ---- push data ---- */
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    const volume = volumeRef.current;
    if (chart === null || candle === null || volume === null) return;

    if (dataset === null) {
      hasDataRef.current = false;
      pushedRef.current = null;
      candle.setData([]);
      volume.setData([]);
      return;
    }

    const timeScale = chart.timeScale();
    const prepended = dataset.prepended;
    const shape: PushedShape = {
      timeframe: dataset.timeframe,
      startIndex: dataset.startIndex,
      length: dataset.bars.length,
    };
    const pushed = pushedRef.current;
    const sameAnchor =
      pushed !== null &&
      hasDataRef.current &&
      prepended === 0 &&
      pushed.timeframe === shape.timeframe &&
      pushed.startIndex === shape.startIndex;

    // Replay step: the previous data plus exactly one bar at the tail.
    // `update()` appends in O(1), keeps the viewport where the user left it
    // and lets the chart follow the new bar if they are at the right edge —
    // `setData()` would rebuild the series and snap the range to the tail.
    if (sameAnchor && shape.length === pushed.length + 1) {
      const bar = dataset.bars[dataset.bars.length - 1];
      try {
        candle.update(toCandle(bar));
        volume.update(toVolume(bar));
        pushedRef.current = shape;
        return;
      } catch {
        // `update()` throws on an out-of-order time; fall through to the
        // full path, which is always correct.
      }
    }

    // Only a flag changed (e.g. `hasNewer` flipping at the end of data): the
    // series already holds exactly these bars.
    if (sameAnchor && shape.length === pushed.length) return;

    // Replay step back: the previous data minus exactly one bar at the tail.
    // lightweight-charts has no "pop", so this goes through `setData()` like
    // the default path — but it must NOT reset the viewport the way that path
    // does. The remaining bars keep their logical indices (nothing was added
    // at the front), so the range captured before `setData` is re-applied
    // unshifted below.
    const shrunk = sameAnchor && shape.length === pushed.length - 1;

    // Logical indices are counted from bars[0], so prepending N bars shifts the
    // user's viewport by +N. Capture the range BEFORE setData and re-apply it
    // shifted, otherwise the chart jumps N bars back into history.
    const previousRange =
      prepended > 0 || shrunk ? timeScale.getVisibleLogicalRange() : null;

    const candleData: CandlestickData<Time>[] = new Array(dataset.bars.length);
    const volumeData: HistogramData<Time>[] = new Array(dataset.bars.length);

    for (let i = 0; i < dataset.bars.length; i += 1) {
      const bar = dataset.bars[i];
      candleData[i] = toCandle(bar);
      volumeData[i] = toVolume(bar);
    }

    candle.setData(candleData);
    volume.setData(volumeData);
    hasDataRef.current = candleData.length > 0;
    pushedRef.current = shape;

    if (previousRange !== null && prepended > 0) {
      timeScale.setVisibleLogicalRange({
        from: previousRange.from + prepended,
        to: previousRange.to + prepended,
      });
    } else if (previousRange !== null && shrunk) {
      // Shrink-by-one: same indices, same range. `setData` snapped the view to
      // the new tail; put it back exactly where the user had it.
      timeScale.setVisibleLogicalRange(previousRange);
    } else if (prepended === 0 && candleData.length > 0) {
      const count = candleData.length;
      timeScale.setVisibleLogicalRange({
        from: Math.max(0, count - INITIAL_VISIBLE_BARS),
        to: count,
      });
    }
  }, [dataset]);

  const latestBar =
    dataset !== null && dataset.bars.length > 0
      ? dataset.bars[dataset.bars.length - 1]
      : null;
  const hoveredBar =
    hoveredTime === null ? null : (barsByTime.get(hoveredTime) ?? null);
  const hoveredIndex =
    hoveredTime === null ? null : (indexByTime.get(hoveredTime) ?? null);
  const legendBar = hoveredBar ?? latestBar;

  return (
    <div className="relative min-h-0 flex-1 bg-term-bg">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Transparent capture surface. `pointer-events` is none unless a tool
          is armed or a drag is running, so the chart keeps every event. */}
      <div
        ref={overlayRef}
        style={overlayStyle}
        className="absolute inset-0 z-20"
      />

      {badge !== null ? (
        <DeleteBadge x={badge.x} y={badge.y} onDelete={deleteSelected} />
      ) : null}

      <OhlcLegend
        symbol={symbol}
        timeframe={timeframe}
        bar={legendBar}
        isLatest={hoveredBar === null && latestBar !== null}
        pricePrecision={pricePrecision}
      />

      <IndicatorLegend
        instances={indicators}
        values={indicatorValues}
        index={hoveredIndex}
        pricePrecision={pricePrecision}
        onToggleVisible={(instanceId) =>
          onIndicatorsChange?.(
            indicators.map((instance) =>
              instance.instanceId === instanceId
                ? { ...instance, visible: !instance.visible }
                : instance,
            ),
          )
        }
        onRemove={(instanceId) =>
          onIndicatorsChange?.(
            indicators.filter((instance) => instance.instanceId !== instanceId),
          )
        }
        onConfigure={(instanceId) => onConfigureIndicator?.(instanceId)}
      />

      {loadingOlder ? (
        <div className="pointer-events-none absolute left-2 bottom-8 z-10 flex items-center gap-1.5 rounded-md border border-term-border bg-term-bg/85 px-2 py-1 text-small tracking-[0.01em] text-term-muted">
          <span className="h-1.5 w-1.5 animate-pulse bg-term-accent" />
          loading history
        </div>
      ) : null}

      {olderError !== null ? (
        <div className="absolute left-2 bottom-8 z-10 rounded-md border border-term-down/50 bg-term-bg/90 px-2 py-1 text-small text-term-down">
          history load failed — {olderError}
        </div>
      ) : null}

      {dataset !== null && !dataset.hasMore ? (
        <div className="pointer-events-none absolute left-2 bottom-8 z-10 rounded-md border border-term-border bg-term-bg/85 px-2 py-1 text-small tracking-[0.01em] text-term-muted">
          start of series
        </div>
      ) : null}

      {loading ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-term-bg/90">
          <div className="flex items-center gap-2 text-body tracking-[0.01em] text-term-muted">
            <span className="h-1.5 w-1.5 animate-pulse bg-term-accent" />
            loading {timeframe}
          </div>
        </div>
      ) : null}

      {error !== null ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-term-bg/95 p-6">
          <div className="max-w-md rounded-md border border-term-down/40 bg-term-panel p-4">
            <p className="text-body font-semibold tracking-[0.01em] text-term-down">
              Chart data unavailable
            </p>
            <p className="mt-2 font-mono text-body text-term-text">
              {error}
            </p>
            <button
              type="button"
              onClick={reload}
              className="mt-3 rounded-md border border-term-border-strong px-2 py-1 text-body text-term-dim transition-colors hover:bg-term-border hover:text-term-text"
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
