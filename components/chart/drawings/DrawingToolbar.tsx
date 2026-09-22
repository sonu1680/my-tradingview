'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { shortcutHint } from './useDrawings';
import type { DrawingStyle, ToolId } from '@/lib/drawings/types';

interface DrawingToolbarProps {
  tool: ToolId;
  onToolChange: (tool: ToolId) => void;
  style: DrawingStyle;
  onStyleChange: (style: DrawingStyle) => void;
  onClearAll: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const WIDTHS = [1, 2, 3, 4] as const;

/**
 * 36px controls in a 52px rail.
 *
 * The idle state carries no border. An earlier version outlined every button on
 * hover, which made the whole rail twitch as the pointer crossed it; the weight
 * now lives in a soft fill, and only the ARMED tool gets a hairline ring plus
 * the accent bar in `ActiveMark`. That way exactly one control ever looks
 * pressed, which is the one piece of state this rail has to communicate.
 */
const BUTTON =
  'group relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[5px] transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-term-accent/70';
const IDLE = 'text-term-dim hover:bg-white/[0.055] hover:text-term-text';
const DISABLED = 'text-term-border-strong cursor-default';
const ACTIVE =
  'bg-term-accent/[0.14] text-term-accent shadow-[inset_0_0_0_1px_rgba(232,179,57,0.32)]';

/** The armed-tool marker: a short accent bar against the rail's inner edge. */
function ActiveMark() {
  return (
    <span
      aria-hidden
      className="absolute left-[-6px] top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-term-accent"
    />
  );
}

/** A hairline that fades at both ends rather than stopping dead. */
function Divider() {
  return (
    <span
      aria-hidden
      className="my-1.5 h-px w-7 shrink-0 bg-gradient-to-r from-transparent via-term-border-strong to-transparent"
    />
  );
}

/* ---- icons: a 16-unit viewBox drawn at 19px (+20%), so no path needs reworking ---- */

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="19"
      height="19"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      {children}
    </svg>
  );
}

const ICONS: Record<ToolId, ReactNode> = {
  cursor: (
    <Icon>
      <path d="M3.5 2.2 L3.5 12.4 L6.2 9.8 L8.1 13.6 L9.9 12.7 L8.1 9.2 L11.8 9.2 Z" />
    </Icon>
  ),
  trendline: (
    <Icon>
      <path d="M3 12.5 L13 3.5" />
      <rect x="1.6" y="11.1" width="2.8" height="2.8" />
      <rect x="11.6" y="2.1" width="2.8" height="2.8" />
    </Icon>
  ),
  hline: (
    <Icon>
      <path d="M1.5 8 H14.5" />
      <rect x="6.6" y="6.6" width="2.8" height="2.8" />
    </Icon>
  ),
  vline: (
    <Icon>
      <path d="M8 1.5 V14.5" />
      <rect x="6.6" y="6.6" width="2.8" height="2.8" />
    </Icon>
  ),
  rect: (
    <Icon>
      <rect x="2.5" y="4" width="11" height="8" />
    </Icon>
  ),
  fib: (
    <Icon>
      <path d="M2 3 H14" />
      <path d="M2 6.2 H14" />
      <path d="M2 9.4 H14" />
      <path d="M2 12.6 H14" />
      <path d="M5 3 V12.6" strokeDasharray="1.5 1.5" />
    </Icon>
  ),
  long: (
    <Icon>
      <rect x="2.5" y="2.5" width="11" height="5" />
      <rect x="2.5" y="8.5" width="11" height="5" strokeDasharray="1.5 1.5" />
      <path d="M8 12.5 V4.5 M6 6.5 L8 4.4 L10 6.5" />
    </Icon>
  ),
  short: (
    <Icon>
      <rect x="2.5" y="8.5" width="11" height="5" />
      <rect x="2.5" y="2.5" width="11" height="5" strokeDasharray="1.5 1.5" />
      <path d="M8 3.5 V11.5 M6 9.5 L8 11.6 L10 9.5" />
    </Icon>
  ),
};

/* ---- history icons: a curved arrow, mirrored for redo ---- */

const UNDO_ICON = (
  <Icon>
    <path d="M3 7.5 H9.2 A3.3 3.3 0 0 1 9.2 14 H5" />
    <path d="M5.6 4.4 L2.4 7.5 L5.6 10.6" />
  </Icon>
);

const REDO_ICON = (
  <Icon>
    <path d="M13 7.5 H6.8 A3.3 3.3 0 0 0 6.8 14 H11" />
    <path d="M10.4 4.4 L13.6 7.5 L10.4 10.6" />
  </Icon>
);

/** Exported so the shortcuts sheet names tools exactly as the toolbar does. */
export const TOOL_LABELS: Record<ToolId, string> = {
  cursor: 'Cursor',
  trendline: 'Trend line',
  hline: 'Horizontal line',
  vline: 'Vertical line',
  rect: 'Rectangle',
  fib: 'Fib retracement',
  long: 'Long position',
  short: 'Short position',
};

const GROUPS: ToolId[][] = [
  ['cursor'],
  ['trendline', 'hline', 'vline', 'rect', 'fib'],
  ['long', 'short'],
];

export default function DrawingToolbar({
  tool,
  onToolChange,
  style,
  onStyleChange,
  onClearAll,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: DrawingToolbarProps) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const askClear = () => {
    setConfirming(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setConfirming(false), 4000);
  };

  const cancelClear = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setConfirming(false);
  };

  const cycleWidth = () => {
    const index = WIDTHS.indexOf(style.width as (typeof WIDTHS)[number]);
    const next = WIDTHS[(index + 1) % WIDTHS.length];
    onStyleChange({ ...style, width: next });
  };

  return (
    // `overflow-y-auto` rather than clipping: at a short viewport the rail
    // scrolls instead of losing its bottom controls. A default scrollbar eats
    // 16 of the 72px and leaves the 56px controls flush against both edges, so
    // the rail asks for a thin one and keeps a little air around them.
    <div className="z-30 flex w-[52px] shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-term-border bg-gradient-to-b from-term-panel via-term-panel to-[#0c0e11] py-2.5 shadow-[inset_-1px_0_0_rgba(255,255,255,0.02)] [scrollbar-color:var(--color-term-border-strong)_transparent] [scrollbar-width:thin]">
      {GROUPS.map((group, index) => (
        <div key={group[0]} className="flex flex-col items-center gap-0.5">
          {index > 0 ? <Divider /> : null}
          {group.map((id) => {
            const hint = shortcutHint(id);
            const armed = tool === id;
            return (
              <button
                key={id}
                type="button"
                aria-label={TOOL_LABELS[id]}
                aria-pressed={armed}
                title={hint === '' ? TOOL_LABELS[id] : `${TOOL_LABELS[id]} (${hint})`}
                onClick={() => onToolChange(id)}
                className={`${BUTTON} ${armed ? ACTIVE : IDLE}`}
              >
                {armed ? <ActiveMark /> : null}
                {ICONS[id]}
              </button>
            );
          })}
        </div>
      ))}

      <Divider />

      <button
        type="button"
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={onUndo}
        className={`${BUTTON} ${canUndo ? IDLE : DISABLED}`}
      >
        {UNDO_ICON}
      </button>

      <button
        type="button"
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={onRedo}
        className={`${BUTTON} ${canRedo ? IDLE : DISABLED}`}
      >
        {REDO_ICON}
      </button>

      <Divider />

      <label
        title={`Drawing colour — ${style.color}`}
        className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[5px] transition-colors hover:bg-white/[0.055]"
      >
        <span className="sr-only">Drawing colour</span>
        <span
          aria-hidden
          className="h-[18px] w-[18px] rounded-[3px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22)]"
          style={{ backgroundColor: style.color }}
        />
        <input
          type="color"
          value={style.color}
          onChange={(event) =>
            onStyleChange({ ...style, color: event.target.value })
          }
          className="sr-only"
        />
      </label>

      <button
        type="button"
        title={`Line width ${style.width}px — click to cycle`}
        onClick={cycleWidth}
        className={`${BUTTON} ${IDLE} font-mono text-small tabular-nums`}
      >
        {style.width}
        {/* "4px" fits the 36px control with room to spare at --text-small. */}
        <span className="ml-px text-tiny text-term-muted">px</span>
      </button>

      <Divider />

      {confirming ? (
        <div className="flex flex-col items-center gap-0.5">
          <button
            type="button"
            title="Confirm — delete every drawing and clear the Count log"
            onClick={() => {
              cancelClear();
              onClearAll();
            }}
            className={`${BUTTON} text-term-down shadow-[inset_0_0_0_1px_rgba(239,83,80,0.45)] hover:bg-term-down/15`}
          >
            <Icon>
              <path d="M3 8.4 L6.4 12 L13 4.4" strokeWidth="1.6" />
            </Icon>
          </button>
          <button
            type="button"
            title="Keep the drawings"
            onClick={cancelClear}
            className={`${BUTTON} ${IDLE}`}
          >
            <Icon>
              <path d="M4 4 L12 12 M12 4 L4 12" />
            </Icon>
          </button>
        </div>
      ) : (
        <button
          type="button"
          title="Clear all drawings and the Count log"
          onClick={askClear}
          className={`${BUTTON} ${IDLE} hover:text-term-down`}
        >
          <Icon>
            <path d="M2.5 4.5 H13.5 M6 4.5 V3 H10 V4.5 M4 4.5 L4.8 13.5 H11.2 L12 4.5" />
          </Icon>
        </button>
      )}
    </div>
  );
}
