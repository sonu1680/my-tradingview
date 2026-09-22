'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ChartPanel from '@/components/chart/ChartPanel';
import DrawingToolbar from '@/components/chart/drawings/DrawingToolbar';
import PositionInspector from '@/components/chart/drawings/PositionInspector';
import { useDrawingHistory } from '@/components/chart/drawings/useDrawingHistory';
import CountBadge from '@/components/chart/counter/CountBadge';
import CountLogDialog from '@/components/chart/counter/CountLogDialog';
import { useCountMode } from '@/components/chart/counter/useCountMode';
import IndicatorDialog from '@/components/chart/indicators/IndicatorDialog';
import IndicatorPanel from '@/components/chart/IndicatorPanel';
import ShortcutsDialog from '@/components/chart/ShortcutsDialog';
import ReplayBar from '@/components/chart/replay/ReplayBar';
import { useReplay } from '@/components/chart/replay/useReplay';
import TimeframeBar from '@/components/chart/TimeframeBar';
import {
  DEFAULT_BIG_BODY_STYLE,
  type BigBodyStyle,
} from '@/components/chart/primitives/BigBodyPrimitive';
import { useBigBody } from '@/components/chart/useBigBody';
import { formatServerTime, useCandleData } from '@/components/chart/useCandleData';
import { SYMBOL, type Timeframe, type TimeframeInfo } from '@/lib/candles/types';
import { loadDrawings, saveDrawings } from '@/lib/drawings/storage';
import {
  DEFAULT_STYLE,
  type Drawing,
  type DrawingStyle,
  type PositionDrawing,
  type ToolId,
} from '@/lib/drawings/types';
import type { IndicatorInstance } from '@/lib/indicators/catalog';
import { loadStudio, saveStudio } from '@/lib/indicators/studioStorage';
import {
  DEFAULT_BIG_BODY_PARAMS,
  type BigBodyParams,
} from '@/lib/indicators/types';
import { safeFetch } from '@/lib/http/safe-fetch';

const DEFAULT_TIMEFRAME: Timeframe = 'M15';
/** A drag must not write on every mousemove. */
const DRAWINGS_SAVE_DELAY_MS = 300;
/** Same idea for the indicator layout: a period stepper must not write per click. */
const STUDIO_SAVE_DELAY_MS = 300;

interface TimeframesResponse {
  symbol: string;
  timeframes: TimeframeInfo[];
}

export default function Home() {
  const [timeframe, setTimeframe] = useState<Timeframe>(DEFAULT_TIMEFRAME);
  const [infos, setInfos] = useState<TimeframeInfo[] | null>(null);

  // The indicator is OFF by default: the chart must behave exactly as it did
  // before until the user asks for it.
  const [bigBodyEnabled, setBigBodyEnabled] = useState(false);
  // The whole `BigBodyParams` shape lives here, including the threshold-rule
  // fields (`thresholdMode`, `thresholdPercent`, `atrPeriod`, `atrMultiple`):
  // seeding from `DEFAULT_BIG_BODY_PARAMS` keeps the panel on Pine's own
  // `pips` rule until the user switches it.
  const [bigBodyParams, setBigBodyParams] = useState<BigBodyParams>(
    DEFAULT_BIG_BODY_PARAMS,
  );
  const [bigBodyStyle, setBigBodyStyle] = useState<BigBodyStyle>(
    DEFAULT_BIG_BODY_STYLE,
  );

  // Bar replay. `replayUntil` is the one bit of state that decides live vs
  // replay: null is the live tail; a time (unix seconds, server) anchors the
  // "as of" page. The candle store is called HERE rather than inside the chart
  // because the replay strip under the header steps the same dataset the
  // chart draws.
  const [replayUntil, setReplayUntil] = useState<number | null>(null);
  const candles = useCandleData(timeframe, replayUntil);
  const replay = useReplay({ until: replayUntil, onUntilChange: setReplayUntil, candles });

  /**
   * A timeframe switch during replay keeps the cutoff TIME, not the index:
   * the anchor is moved to the current cutoff in the same render as the
   * timeframe, so the store issues exactly one `until` fetch on the new
   * timeframe and the server recomputes the index.
   */
  const changeTimeframe = (next: Timeframe) => {
    if (replay.active && replay.cutoffTime !== null) setReplayUntil(replay.cutoffTime);
    setTimeframe(next);
  };

  // The indicator follows the replay clock; outside replay it sends nothing
  // new, so its cache keys are unchanged.
  const bigBody = useBigBody(timeframe, bigBodyParams, bigBodyEnabled, replay.cutoffTime);

  // Drawings are per-symbol and shared across every timeframe: this state is
  // deliberately NOT keyed by `timeframe`, so switching one never clears them.
  const [tool, setTool] = useState<ToolId>('cursor');
  // Every mutation funnels through this hook, which decides what is one
  // undoable step: a whole drag, a whole field edit, a create, a delete.
  const history = useDrawingHistory();
  const { drawings, setDrawings, reset: resetDrawings } = history;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawingStyle, setDrawingStyle] = useState<DrawingStyle>(DEFAULT_STYLE);
  const drawingsLoadedRef = useRef(false);
  /**
   * The same fact as `drawingsLoadedRef`, but as state.
   *
   * Count mode's log mirrors the chart, so it has to know the difference
   * between "no positions drawn" and "the drawings have not been read off disk
   * yet" — a ref cannot tell it, because changing one re-renders nothing.
   */
  const [drawingsLoaded, setDrawingsLoaded] = useState(false);

  // localStorage is client-only, so the read is deferred off the first render
  // rather than done in an initializer that would also run during SSR.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      drawingsLoadedRef.current = true;
      // `reset`, not `setDrawings`: what was on disk is the starting point, so
      // undo must never walk back past it to an empty chart.
      resetDrawings(loadDrawings(SYMBOL));
      setDrawingsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [resetDrawings]);

  useEffect(() => {
    if (!drawingsLoadedRef.current) return;
    const timer = setTimeout(() => {
      saveDrawings(SYMBOL, drawings);
    }, DRAWINGS_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [drawings]);

  /**
   * Swallow AbortError at the window level.
   *
   * Every abort in this app is deliberate: an effect cleaning up, or a newer
   * request superseding an older one. The call sites already catch it, but a
   * fetch promise can reject in the window between its creation and the await
   * attaching a handler, and Chrome then reports "Uncaught (in promise)".
   *
   * In Next's dev mode an unhandled rejection raises the full-screen error
   * overlay, which is modal, swallows every click and clears only on reload —
   * indistinguishable from the app hanging. This net is deliberately narrow:
   * ONLY AbortError, and it never hides a real failure.
   */
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      const name =
        typeof reason === 'object' && reason !== null && 'name' in reason
          ? (reason as { name?: unknown }).name
          : undefined;
      if (name === 'AbortError') event.preventDefault();
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);

  useEffect(() => {
    // See the note in useCandleData: no AbortController here on purpose.
    let cancelled = false;
    void (async () => {
      try {
        const res = await safeFetch('/api/timeframes', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as TimeframesResponse;
        if (!cancelled && Array.isArray(body.timeframes)) setInfos(body.timeframes);
      } catch {
        // The availability list is an enhancement: if it fails, every button
        // stays enabled and the candles endpoint reports the real error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const unavailable = useMemo(() => {
    const set = new Set<Timeframe>();
    if (infos === null) return set;
    for (const info of infos) {
      // `totalBars` is null until the store lazily loads a timeframe, so it is
      // not an availability signal. A timeframe is genuinely absent only when
      // the store knows nothing about it at all.
      const present =
        info.firstTime !== null || info.lastTime !== null || (info.totalBars ?? 0) > 0;
      if (!present) set.add(info.timeframe);
    }
    return set;
  }, [infos]);

  const active = infos?.find((info) => info.timeframe === timeframe) ?? null;

  const selected = drawings.find((drawing) => drawing.id === selectedId) ?? null;
  const selectedPosition: PositionDrawing | null =
    selected !== null && selected.kind === 'position' ? selected : null;

  const replaceDrawing = (next: Drawing) => {
    setDrawings((previous) =>
      previous.map((drawing) => (drawing.id === next.id ? next : drawing)),
    );
  };

  /** A keystroke inside an open field edit: applied, but not its own step. */
  const replaceDrawingTransient = (next: Drawing) => {
    history.setDrawingsTransient((previous) =>
      previous.map((drawing) => (drawing.id === next.id ? next : drawing)),
    );
  };

  const deleteSelected = () => {
    setDrawings((previous) =>
      previous.filter((drawing) => drawing.id !== selectedId),
    );
    setSelectedId(null);
  };

  /**
   * Count mode — the opt-in running log of the positions drawn from the moment
   * it is switched on. It lives HERE rather than inside the backtest panel for
   * two reasons: the badge is an overlay on the chart, and the log has to keep
   * counting while the panel is collapsed or on another tab.
   *
   * It is fed the replay cutoff, so a trade drawn inside replay reads OPEN and
   * resolves by itself as replay advances.
   */
  const countMode = useCountMode({
    symbol: SYMBOL,
    drawings,
    timeframe,
    cutoffTime: replay.cutoffTime,
    drawingsLoaded,
  });

  /**
   * User-added studies (EMA, RSI, MACD, ...).
   *
   * Kept here rather than inside the chart for the same reason as the drawings:
   * they are a property of the SYMBOL, not of the timeframe, so switching from
   * M15 to H1 must not silently drop the user's 200 EMA.
   */
  const [indicators, setIndicators] = useState<IndicatorInstance[]>([]);
  const [studioOpen, setStudioOpen] = useState(false);
  /** Which row the dialog should open expanded, when reached from a legend gear. */
  const [studioFocus, setStudioFocus] = useState<string | null>(null);
  const studioLoadedRef = useRef(false);

  // Deferred off the first render, not read in an initializer: localStorage
  // does not exist during SSR.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      studioLoadedRef.current = true;
      setIndicators(loadStudio(SYMBOL));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Guarded on the load having happened: otherwise the first render would
    // write an empty layout over whatever is on disk.
    if (!studioLoadedRef.current) return;
    const timer = setTimeout(() => {
      saveStudio(SYMBOL, indicators);
    }, STUDIO_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [indicators]);

  const openStudio = (focus: string | null) => {
    setStudioFocus(focus);
    setStudioOpen(true);
  };

  const [logScale, setLogScale] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  /**
   * `?` opens the shortcut sheet.
   *
   * Every other shortcut in the app is on a tool or the replay controls, so
   * there was no way to discover them; this is the one key that advertises the
   * rest. Ignored while a field has focus, like the others.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '?') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }
      event.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * Clear all: the chart AND the Count log.
   *
   * The Count log mirrors the chart, so emptying the chart empties the log.
   * `countMode.clear()` also drops the STORED copy, which a plain filter would
   * not: without it the rows would come back on the next reload.
   */
  const clearDrawings = () => {
    setDrawings([]);
    setSelectedId(null);
    countMode.clear();
  };

  // Count mode's own surface. The switch has to be reachable while the mode is
  // OFF — the on-chart badge only renders while it is on — so the header button
  // opens this, and so does the badge.
  const [countOpen, setCountOpen] = useState(false);

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-x-hidden bg-term-bg text-term-text">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-term-border bg-gradient-to-b from-term-panel to-[#14171d] px-4 py-2.5 shadow-sm shadow-black/30">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="h-7 w-[3px] rounded-full bg-gradient-to-b from-term-accent to-term-accent/25"
          />
          <div className="flex flex-col leading-none">
            <h1 className="text-head font-semibold tracking-[0.01em] text-term-text">
              {SYMBOL}
            </h1>
            <span className="mt-1 whitespace-nowrap text-tiny text-term-muted">
              Gold · Spot
            </span>
          </div>
        </div>

        <TimeframeBar
          value={timeframe}
          onChange={changeTimeframe}
          unavailable={unavailable}
        />

        <button
          type="button"
          onClick={() => openStudio(null)}
          title="Add or edit indicators"
          className="flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-tiny text-term-dim ring-1 ring-inset ring-term-border transition-colors hover:bg-white/[0.06] hover:text-term-text"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M2 13.5c1.6 0 2.1-1 2.4-2.6L6 3.1C6.3 1.5 6.8.5 8.4.5" />
            <path d="M3.3 6.5h5.2" />
            <path d="M10 9l4.2 4.2M14.2 9L10 13.2" />
          </svg>
          Indicators
          {indicators.length > 0 ? (
            <span className="font-mono tabular-nums text-term-accent">
              {indicators.length}
            </span>
          ) : null}
        </button>

        <button
          type="button"
          onClick={() => setLogScale(!logScale)}
          aria-pressed={logScale}
          title="Logarithmic price axis — equal percentage moves take equal vertical space"
          className={`shrink-0 whitespace-nowrap border px-2 py-1 font-mono text-tiny tracking-[0.01em] transition-colors ${
            logScale
              ? 'border-term-accent/60 bg-term-accent/10 text-term-accent'
              : 'border-term-border-strong text-term-dim hover:bg-term-border hover:text-term-text'
          }`}
        >
          Log
        </button>

        <button
          type="button"
          onClick={() => setCountOpen(true)}
          title="Count mode — log every position you draw, with win/loss, pips and CSV export"
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border px-2 py-1 text-tiny tracking-[0.01em] transition-colors ${
            countMode.enabled
              ? 'border-term-accent/60 bg-term-accent/10 text-term-accent'
              : 'border-term-border-strong text-term-dim hover:bg-term-border hover:text-term-text'
          }`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${
              countMode.enabled ? 'bg-term-accent' : 'bg-term-border-strong'
            }`}
          />
          Count
          {countMode.trades.length > 0 ? (
            <span className="font-mono tabular-nums">{countMode.trades.length}</span>
          ) : null}
        </button>

        <button
          type="button"
          onClick={() => setShortcutsOpen(true)}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-tiny text-term-dim ring-1 ring-inset ring-term-border transition-colors hover:bg-white/[0.06] hover:text-term-text"
        >
          ?
        </button>

        <div className="ml-auto flex items-center gap-3">
          {active?.totalBars != null ? (
            <span className="whitespace-nowrap font-mono text-small tabular-nums text-term-muted">
              {active.totalBars.toLocaleString('en-US')} bars
            </span>
          ) : null}
          <span
            title="All timestamps are broker server time. They are never shifted to your local timezone."
            className="flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-term-bg/60 px-2.5 text-tiny text-term-dim ring-1 ring-inset ring-term-border"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-term-accent" />
            Server time
          </span>
        </div>
      </header>

      <ReplayBar
        replay={replay}
        minDate={active?.firstTime != null ? formatServerTime(active.firstTime, false) : undefined}
        maxDate={active?.lastTime != null ? formatServerTime(active.lastTime, false) : undefined}
      />

      <div className="relative flex min-h-0 flex-1">
        <DrawingToolbar
          tool={tool}
          onToolChange={setTool}
          style={drawingStyle}
          onStyleChange={setDrawingStyle}
          onClearAll={clearDrawings}
          onUndo={history.undo}
          onRedo={history.redo}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
        />
        <ChartPanel
          symbol={SYMBOL}
          timeframe={timeframe}
          candles={candles}
          bigBody={bigBody.data}
          bigBodyStyle={bigBodyStyle}
          indicators={indicators}
          onIndicatorsChange={setIndicators}
          onConfigureIndicator={openStudio}
          logScale={logScale}
          tool={tool}
          onToolChange={setTool}
          drawings={drawings}
          onDrawingsChange={setDrawings}
          selectedId={selectedId}
          onSelectedIdChange={setSelectedId}
          drawingStyle={drawingStyle}
          drawingHistory={history}
        />
        {countMode.enabled ? (
          <CountBadge
            summary={countMode.summary}
            busy={countMode.busy}
            error={countMode.error}
            onOpenLog={() => setCountOpen(true)}
          />
        ) : null}
        <IndicatorPanel
          enabled={bigBodyEnabled}
          onEnabledChange={setBigBodyEnabled}
          params={bigBodyParams}
          onParamsChange={setBigBodyParams}
          style={bigBodyStyle}
          onStyleChange={setBigBodyStyle}
          stats={bigBody.data?.stats ?? null}
          loading={bigBody.loading}
          error={bigBody.error}
        />
        {selectedPosition !== null ? (
          <PositionInspector
            position={selectedPosition}
            onChange={replaceDrawing}
            onTransientChange={replaceDrawingTransient}
            onEditStart={history.beginTransaction}
            onEditEnd={history.commitTransaction}
            onDelete={deleteSelected}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>

      {/* Mounted only while open, and keyed by the row it was opened from, so
          it starts in the right place without syncing props into state. */}
      {studioOpen ? (
        <IndicatorDialog
          key={studioFocus ?? 'catalog'}
          onClose={() => setStudioOpen(false)}
          instances={indicators}
          onInstancesChange={setIndicators}
          focusInstanceId={studioFocus}
        />
      ) : null}

      {shortcutsOpen ? (
        <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />
      ) : null}

      {countOpen ? (
        <CountLogDialog countMode={countMode} onClose={() => setCountOpen(false)} />
      ) : null}
    </main>
  );
}
