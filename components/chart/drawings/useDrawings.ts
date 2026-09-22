'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { DrawingsPrimitive } from './DrawingsPrimitive';
import type { DrawingHistoryControls } from './useDrawingHistory';
import {
  drawingFromDraft,
  hitTest,
  moveDrawing,
  moveHandle,
} from '@/lib/drawings/geometry';
import {
  TOOL_CLICKS,
  type Anchor,
  type Draft,
  type Drawing,
  type DrawingStyle,
  type Hit,
  type Pt,
  type ToolId,
} from '@/lib/drawings/types';

/**
 * The interaction layer for the drawing tools.
 *
 * Two DOM surfaces, deliberately:
 *
 *  - The chart container, listened to in the CAPTURE phase. Nothing is
 *    swallowed there unless a mousedown actually lands on a drawing, so with
 *    the cursor tool the chart keeps every event it has today — pan, zoom,
 *    crosshair, axis drag, scroll-back paging.
 *  - A transparent overlay sibling, `pointer-events: none` by default and
 *    `auto` only while a tool is armed or a drag is running. That is what
 *    stops lightweight-charts from panning underneath a placement.
 *
 * Every pixel <-> chart-space conversion goes through the primitive
 * (`project` / `toAnchor` / `toPoint`). A second implementation of time->x
 * would drift from what is painted and hit-testing would stop matching.
 */

export interface UseDrawingsOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  chartRef: RefObject<IChartApi | null>;
  primitiveRef: RefObject<DrawingsPrimitive | null>;
  tool: ToolId;
  onToolChange: (tool: ToolId) => void;
  drawings: Drawing[];
  onDrawingsChange: (drawings: Drawing[]) => void;
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  style: DrawingStyle;
  /**
   * Undo/redo. Optional: without it the hook behaves exactly as it did before,
   * every change going through `onDrawingsChange`.
   */
  history?: DrawingHistoryControls | null;
}

export interface UseDrawingsResult {
  /** Spread onto the transparent overlay div that sits above the chart. */
  overlayRef: RefObject<HTMLDivElement | null>;
  overlayStyle: CSSProperties;
  /**
   * Deletes the current selection. This is THE deletion path — the Delete /
   * Backspace handler calls exactly this function, so a click on the floating
   * delete badge and a press of Del produce one identical undo step.
   */
  deleteSelected: () => void;
  /**
   * True while a tool is armed, a placement is open, or a drag is running.
   * Chrome anchored to a drawing (the delete badge) hides during these: it
   * would sit under the cursor and fight the gesture, and while the overlay is
   * `auto` it would also steal the first placement click.
   */
  interacting: boolean;
}

/**
 * Plain single-key tool shortcuts, mirrored in the toolbar's `title`
 * attributes. `''` means the tool has no plain key (see `ALT_SHORTCUTS`).
 */
export const TOOL_SHORTCUTS: Record<ToolId, string> = {
  cursor: 'v',
  trendline: 't',
  hline: 'h',
  vline: '',
  rect: 'r',
  fib: 'f',
  long: 'l',
  short: 's',
};

/**
 * Alt-key combos, keyed by the lowercased letter. `V` alone is the cursor and
 * `H` alone the horizontal line, so the vertical line lives on `Alt+V`, and
 * `Alt+H` is offered alongside plain `H` for symmetry.
 */
export const ALT_SHORTCUTS: Readonly<
  Record<string, Exclude<ToolId, 'cursor'>>
> = {
  h: 'hline',
  v: 'vline',
};

/**
 * `"H / Alt+H"`, `"Alt+V"`, `"T"`, … for a toolbar title. Empty for a tool
 * with no shortcut at all, so the caller can omit the parenthetical.
 */
export function shortcutHint(tool: ToolId): string {
  const parts: string[] = [];
  const plain = TOOL_SHORTCUTS[tool];
  if (plain !== '') parts.push(plain.toUpperCase());
  for (const [key, id] of Object.entries(ALT_SHORTCUTS)) {
    if (id === tool) parts.push(`Alt+${key.toUpperCase()}`);
  }
  return parts.join(' / ');
}

const SHORTCUT_TO_TOOL = new Map<string, ToolId>(
  (Object.keys(TOOL_SHORTCUTS) as ToolId[])
    .filter((tool) => TOOL_SHORTCUTS[tool] !== '')
    .map((tool) => [TOOL_SHORTCUTS[tool], tool]),
);

/**
 * The letter an Alt-combo was pressed on. `event.key` is what most layouts
 * report; on macOS `Alt` (Option) turns it into a symbol (`√` for V), so the
 * physical `code` is the fallback.
 */
function altLetter(event: KeyboardEvent): string | null {
  const key = event.key.length === 1 ? event.key.toLowerCase() : null;
  if (key !== null && key in ALT_SHORTCUTS) return key;
  const match = /^Key([A-Z])$/.exec(event.code);
  return match === null ? null : match[1].toLowerCase();
}

interface DragState {
  id: string;
  hit: Hit;
  start: Anchor;
  /** The drawing as it was at mousedown; every frame is computed from it. */
  original: Drawing;
  restore: { handleScroll: unknown; handleScale: unknown } | null;
}

interface Latest {
  tool: ToolId;
  onToolChange: (tool: ToolId) => void;
  drawings: Drawing[];
  onDrawingsChange: (drawings: Drawing[]) => void;
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  style: DrawingStyle;
  draft: Draft | null;
  history: DrawingHistoryControls | null;
}

function newId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useDrawings(options: UseDrawingsOptions): UseDrawingsResult {
  const {
    containerRef,
    chartRef,
    primitiveRef,
    tool,
    onToolChange,
    drawings,
    onDrawingsChange,
    selectedId,
    onSelectedIdChange,
    style,
    history = null,
  } = options;

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Handlers are registered once and read the newest props/state through this
  // box, the same way ChartPanel keeps `loadOlderRef` current.
  const latestRef = useRef<Latest>({
    tool,
    onToolChange,
    drawings,
    onDrawingsChange,
    selectedId,
    onSelectedIdChange,
    style,
    draft,
    history,
  });
  useEffect(() => {
    latestRef.current = {
      tool,
      onToolChange,
      drawings,
      onDrawingsChange,
      selectedId,
      onSelectedIdChange,
      style,
      draft,
      history,
    };
  });

  /**
   * The single deletion path, shared by the Del key and the delete badge.
   * Stable, and it reads the newest props through `latestRef`, so neither
   * caller can drift from the other or land as two undo steps.
   */
  const deleteSelected = useCallback(() => {
    const current = latestRef.current;
    if (current.selectedId === null) return;
    current.onDrawingsChange(
      current.drawings.filter((item) => item.id !== current.selectedId),
    );
    current.onSelectedIdChange(null);
  }, []);

  const dragRef = useRef<DragState | null>(null);
  /**
   * The last pointer position over the chart, in container pixels, or null
   * when the pointer is elsewhere. Alt+H / Alt+V place a line here
   * immediately — no click — so this must be tracked on EVERY move, not only
   * while the cursor tool is active.
   */
  const lastPointRef = useRef<Pt | null>(null);
  const hoverRef = useRef<{ id: string | null; hit: Hit | null }>({
    id: null,
    hit: null,
  });

  /* ---- the renderer is fed the whole view state; it is otherwise stateless ---- */
  useEffect(() => {
    primitiveRef.current?.setState({ drawings, selectedId, hoverId, draft });
  }, [primitiveRef, drawings, selectedId, hoverId, draft]);

  /* ---- cursor feedback follows the armed tool ---- */
  useEffect(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    const value = tool === 'cursor' ? '' : 'crosshair';
    if (overlay !== null) overlay.style.cursor = value;
    if (container !== null) {
      container.style.cursor = value;
      for (const canvas of container.querySelectorAll('canvas')) {
        canvas.style.cursor = value;
      }
    }
  }, [containerRef, tool]);

  /* ---- the state machine ---- */
  useEffect(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (container === null || overlay === null) return;

    /** Cosmetic only: the chart's own canvases set a cursor, so set it there. */
    const setCursor = (value: string) => {
      overlay.style.cursor = value;
      container.style.cursor = value;
      for (const canvas of container.querySelectorAll('canvas')) {
        canvas.style.cursor = value;
      }
    };

    const pointOf = (event: MouseEvent): Pt => {
      const rect = container.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    /** Topmost drawing under `p`. The selection is tested first so its
     *  handles stay grabbable even under a shape drawn later. */
    const pick = (p: Pt): { id: string; hit: Hit } | null => {
      const primitive = primitiveRef.current;
      if (primitive === null) return null;
      const projected = primitive.project(latestRef.current.drawings);
      if (projected === null) return null;

      const topFirst = projected.slice().reverse();
      const currentId = latestRef.current.selectedId;
      const ordered =
        currentId === null
          ? topFirst
          : [
              ...topFirst.filter((item) => item.drawing.id === currentId),
              ...topFirst.filter((item) => item.drawing.id !== currentId),
            ];

      for (const proj of ordered) {
        const hit = hitTest(proj, p);
        if (hit !== null) return { id: proj.drawing.id, hit };
      }
      return null;
    };

    const setHover = (next: { id: string | null; hit: Hit | null }) => {
      const previous = hoverRef.current;
      const sameHit =
        previous.hit === null
          ? next.hit === null
          : next.hit !== null &&
            previous.hit.type === next.hit.type &&
            (previous.hit.type !== 'handle' ||
              next.hit.type !== 'handle' ||
              previous.hit.index === next.hit.index);
      if (previous.id === next.id && sameHit) return;
      hoverRef.current = next;
      setHoverId(next.id);
    };

    const cursorForHit = (hit: Hit | null): string => {
      if (hit === null) return '';
      return hit.type === 'handle' ? 'pointer' : 'move';
    };

    /** `transient: true` is a mid-drag frame: it must not become an undo step. */
    const replaceDrawing = (next: Drawing, transient = false) => {
      const current = latestRef.current;
      const list = current.drawings.map((item) =>
        item.id === next.id ? next : item,
      );
      if (transient && current.history !== null) {
        current.history.setDrawingsTransient(list);
        return;
      }
      current.onDrawingsChange(list);
    };

    /* ---- dragging ---- */

    const beginDrag = (id: string, hit: Hit, p: Pt) => {
      const primitive = primitiveRef.current;
      if (primitive === null) return;
      const start = primitive.toAnchor(p);
      if (start === null) return;
      const original = latestRef.current.drawings.find((item) => item.id === id);
      if (original === undefined) return;

      // A drag must not also pan the chart. The previous values are captured so
      // an axis-drag configuration the user set is not silently flattened.
      // They are DEEP-COPIED: `chart.options()` returns the library's live
      // options object and `applyOptions` merges into its nested objects in
      // place, so a by-reference snapshot would be flattened to all-false by
      // the very call below and `endDrag` would "restore" a dead chart.
      const chart = chartRef.current;
      let restore: DragState['restore'] = null;
      if (chart !== null) {
        const chartOptions = chart.options();
        restore = structuredClone({
          handleScroll: chartOptions.handleScroll,
          handleScale: chartOptions.handleScale,
        });
        chart.applyOptions({ handleScroll: false, handleScale: false });
      }

      dragRef.current = { id, hit, start, original, restore };
      // Everything until `endDrag` collapses into one entry, however many
      // hundred mousemove frames the drag turns out to be.
      latestRef.current.history?.beginTransaction();
      setCursor(cursorForHit(hit));
      setDragging(true);
    };

    /** `commit: false` puts the drawing back the way it was (Esc). */
    const endDrag = (commit: boolean, silent = false) => {
      const drag = dragRef.current;
      if (drag === null) return;
      dragRef.current = null;

      const chart = chartRef.current;
      if (chart !== null) {
        if (drag.restore !== null) {
          chart.applyOptions({
            handleScroll: drag.restore.handleScroll,
            handleScale: drag.restore.handleScale,
          } as Parameters<IChartApi['applyOptions']>[0]);
        } else {
          chart.applyOptions({ handleScroll: true, handleScale: true });
        }
      }

      // The transaction is closed even on the silent path (the effect cleanup
      // of an interrupted drag), so it can never be left permanently open.
      const history = latestRef.current.history;
      if (history !== null) {
        if (commit) history.commitTransaction();
        else history.abortTransaction();
      } else if (!commit) {
        replaceDrawing(drag.original);
      }

      if (silent) return;
      setDragging(false);
    };

    /* ---- placement ---- */

    const commitDraft = (finished: Draft) => {
      const current = latestRef.current;
      const drawing = drawingFromDraft(finished, newId(), current.style);
      setDraft(null);
      // One shape per arm, like TradingView's default.
      current.onToolChange('cursor');
      if (drawing === null) return;
      current.onDrawingsChange([...current.drawings, drawing]);
      current.onSelectedIdChange(drawing.id);
    };

    /* ---- container listeners (capture phase, never greedy) ---- */

    const onContainerMove = (event: MouseEvent) => {
      lastPointRef.current = pointOf(event);
      if (dragRef.current !== null) return;
      if (latestRef.current.tool !== 'cursor') return;
      const found = pick(pointOf(event));
      setHover({ id: found?.id ?? null, hit: found?.hit ?? null });
      setCursor(cursorForHit(found?.hit ?? null));
    };

    const onContainerLeave = () => {
      lastPointRef.current = null;
      if (dragRef.current !== null) return;
      setHover({ id: null, hit: null });
      if (latestRef.current.tool === 'cursor') setCursor('');
    };

    const onContainerDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (latestRef.current.tool !== 'cursor') return;
      const found = pick(pointOf(event));
      if (found === null) {
        // Empty space: clear the selection but let the event through so the
        // chart pans exactly as it does today.
        if (latestRef.current.selectedId !== null) {
          latestRef.current.onSelectedIdChange(null);
        }
        return;
      }
      // Only now do we steal the event, and only from this one mousedown.
      event.preventDefault();
      event.stopPropagation();
      if (latestRef.current.selectedId !== found.id) {
        latestRef.current.onSelectedIdChange(found.id);
      }
      beginDrag(found.id, found.hit, pointOf(event));
    };

    /* ---- overlay listeners (only reachable when it is `auto`) ---- */

    const onOverlayDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const current = latestRef.current;
      if (current.tool === 'cursor') return;
      event.preventDefault();
      const primitive = primitiveRef.current;
      if (primitive === null) return;
      const anchor = primitive.toAnchor(pointOf(event));
      if (anchor === null) return;

      const active = current.draft;
      const points =
        active !== null && active.tool === current.tool
          ? [...active.points, anchor]
          : [anchor];
      const next: Draft = { tool: current.tool, points, cursor: anchor };
      if (points.length >= TOOL_CLICKS[current.tool]) commitDraft(next);
      else setDraft(next);
    };

    const onOverlayMove = (event: MouseEvent) => {
      // The overlay swallows moves while a tool is armed, so track here too.
      lastPointRef.current = pointOf(event);
      if (dragRef.current !== null) return;
      const current = latestRef.current;
      if (current.tool === 'cursor') return;
      const primitive = primitiveRef.current;
      if (primitive === null) return;
      const cursor = primitive.toAnchor(pointOf(event));
      if (cursor === null) return;
      // Before the first click there is no draft yet. Opening an empty one
      // with just the cursor lets the renderer preview a one-click tool
      // (hline / vline) at the pointer; for a two-click tool it draws nothing
      // until a point is placed. A draft left over from another tool is
      // restarted rather than extended.
      const active = current.draft;
      const points =
        active !== null && active.tool === current.tool ? active.points : [];
      setDraft({ tool: current.tool, points, cursor });
    };

    /** The pre-click preview must not linger at the last pointer position. */
    const onOverlayLeave = () => {
      if (dragRef.current !== null) return;
      const active = latestRef.current.draft;
      if (active !== null && active.points.length === 0) setDraft(null);
    };

    /* ---- window listeners: a drag must survive leaving the chart ---- */

    const onWindowMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const primitive = primitiveRef.current;
      if (primitive === null) return;
      const now = primitive.toAnchor(pointOf(event));
      if (now === null) return;

      const next =
        drag.hit.type === 'body'
          ? moveDrawing(
              drag.original,
              now.time - drag.start.time,
              now.price - drag.start.price,
            )
          : moveHandle(drag.original, drag.hit.index, now);
      replaceDrawing(next, true);
    };

    const onWindowUp = () => {
      if (dragRef.current === null) return;
      endDrag(true);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // The toolbar and the inspector have number fields; never hijack those.
      if (isTypingTarget(event.target)) return;
      const current = latestRef.current;

      if (event.key === 'Escape') {
        if (dragRef.current !== null) {
          endDrag(false);
          return;
        }
        if (current.draft !== null) {
          setDraft(null);
          current.onToolChange('cursor');
          return;
        }
        if (current.tool !== 'cursor') {
          current.onToolChange('cursor');
          return;
        }
        if (current.selectedId !== null) current.onSelectedIdChange(null);
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (current.selectedId === null) return;
        event.preventDefault();
        deleteSelected();
        return;
      }

      // Undo/redo lives here so the typing guard above covers it too: inside
      // an inspector field the browser's own text undo must win.
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'z') {
          event.preventDefault();
          if (event.shiftKey) current.history?.redo();
          else current.history?.undo();
          return;
        }
        if (key === 'y' && event.ctrlKey && !event.shiftKey) {
          event.preventDefault();
          current.history?.redo();
          return;
        }
      }

      // Alt combos (Alt+H, Alt+V) are checked before the modifier bail below.
      // `preventDefault` stops the browser treating them as menu accelerators.
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const letter = altLetter(event);
        const altTool = letter === null ? undefined : ALT_SHORTCUTS[letter];
        if (altTool !== undefined) {
          event.preventDefault();
          if (current.draft !== null) setDraft(null);
          // Place the line where the pointer already is, with no click. Both
          // Alt tools are one-click shapes (TOOL_CLICKS === 1), so a single
          // anchor is a complete draft and `commitDraft` finishes it as one
          // undo step.
          const point = lastPointRef.current;
          const primitive = primitiveRef.current;
          const anchor =
            point === null || primitive === null
              ? null
              : primitive.toAnchor(point);
          if (anchor === null) {
            // Pointer is off the chart (or the chart is not ready): fall back
            // to arming the tool so the shortcut still does something.
            current.onToolChange(altTool);
          } else {
            commitDraft({ tool: altTool, points: [anchor], cursor: null });
          }
          return;
        }
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const shortcut = SHORTCUT_TO_TOOL.get(event.key.toLowerCase());
      if (shortcut === undefined) return;
      event.preventDefault();
      if (current.draft !== null) setDraft(null);
      current.onToolChange(shortcut);
    };

    container.addEventListener('mousedown', onContainerDown, true);
    container.addEventListener('mousemove', onContainerMove, true);
    container.addEventListener('mouseleave', onContainerLeave, true);
    overlay.addEventListener('mousedown', onOverlayDown);
    overlay.addEventListener('mousemove', onOverlayMove);
    overlay.addEventListener('mouseleave', onOverlayLeave);
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      container.removeEventListener('mousedown', onContainerDown, true);
      container.removeEventListener('mousemove', onContainerMove, true);
      container.removeEventListener('mouseleave', onContainerLeave, true);
      overlay.removeEventListener('mousedown', onOverlayDown);
      overlay.removeEventListener('mousemove', onOverlayMove);
      overlay.removeEventListener('mouseleave', onOverlayLeave);
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onWindowUp);
      window.removeEventListener('keydown', onKeyDown);
      // An interrupted drag must not leave the chart permanently frozen.
      endDrag(true, true);
    };
  }, [containerRef, chartRef, primitiveRef, deleteSelected]);

  const armed = tool !== 'cursor';
  return {
    overlayRef,
    overlayStyle: {
      pointerEvents: armed || dragging ? 'auto' : 'none',
      cursor: armed ? 'crosshair' : undefined,
    },
    deleteSelected,
    interacting: armed || dragging || draft !== null,
  };
}
