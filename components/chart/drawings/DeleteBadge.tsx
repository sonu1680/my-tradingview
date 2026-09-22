'use client';

/**
 * The floating "delete this drawing" affordance.
 *
 * It is a single absolutely-positioned button — deliberately NOT wrapped in a
 * full-bleed transparent layer. A full-width overlay here would sit above the
 * chart canvas and swallow pan/zoom even with `pointer-events: none` sprinkled
 * on children, a regression we have already paid for once. Only these ~26 CSS
 * pixels take pointer events; everything around them belongs to the chart.
 *
 * Positioning is owned by the caller (ChartPanel), which projects through the
 * drawings primitive. This component only paints.
 */

export const DELETE_BADGE_SIZE = 26;
/** Pixels between the shape's extreme point and the badge's near edge. */
export const DELETE_BADGE_GAP = 10;

interface DeleteBadgeProps {
  /** Badge centre, in CSS pixels relative to the chart container. */
  x: number;
  y: number;
  onDelete: () => void;
}

export default function DeleteBadge({ x, y, onDelete }: DeleteBadgeProps) {
  return (
    <button
      type="button"
      aria-label="Delete drawing"
      title="Delete (Del)"
      // No confirmation by design: one click deletes, and Ctrl+Z is the net.
      onClick={onDelete}
      // The chart listens on mousedown in the capture phase; keep ours to
      // ourselves so clicking the badge never starts a pan or a selection.
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{
        pointerEvents: 'auto',
        left: x - DELETE_BADGE_SIZE / 2,
        top: y - DELETE_BADGE_SIZE / 2,
        width: DELETE_BADGE_SIZE,
        height: DELETE_BADGE_SIZE,
      }}
      className="absolute z-30 flex items-center justify-center rounded-md border border-term-border-strong bg-term-panel/95 text-term-dim shadow-[0_1px_4px_rgba(0,0,0,0.5)] transition-colors hover:border-term-down hover:bg-term-down/20 hover:text-term-down focus-visible:border-term-down focus-visible:outline-none"
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="square"
        strokeLinejoin="miter"
      >
        <path d="M2.5 4.5 H13.5 M6 4.5 V3 H10 V4.5 M4 4.5 L4.8 13.5 H11.2 L12 4.5" />
      </svg>
    </button>
  );
}
