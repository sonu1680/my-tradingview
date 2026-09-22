'use client';

import { useEffect } from 'react';
import { TOOL_LABELS } from './drawings/DrawingToolbar';
import { shortcutHint } from './drawings/useDrawings';
import type { ToolId } from '@/lib/drawings/types';

/**
 * The keyboard reference.
 *
 * Drawing-tool rows are DERIVED from `TOOL_LABELS` and `shortcutHint`, the same
 * tables the toolbar and the key handler read, so this sheet cannot drift out
 * of date the way a hand-written list would. The replay and editing rows are
 * listed explicitly because their keys live inside their own hooks; each one is
 * annotated with where it is implemented so the pair stays findable.
 */

interface Row {
  keys: string[];
  action: string;
}

const TOOL_ORDER: ToolId[] = [
  'cursor', 'trendline', 'hline', 'vline', 'rect', 'fib', 'long', 'short',
];

/** `useReplay`'s window listener. All three are ignored while a field is focused. */
const REPLAY_ROWS: Row[] = [
  { keys: ['Space'], action: 'Play / pause replay' },
  { keys: ['→'], action: 'Step forward one bar' },
  { keys: ['←'], action: 'Step back one bar' },
];

/** `useDrawings`' window listener. */
const EDIT_ROWS: Row[] = [
  { keys: ['Ctrl', 'Z'], action: 'Undo' },
  { keys: ['Ctrl', 'Shift', 'Z'], action: 'Redo' },
  { keys: ['Ctrl', 'Y'], action: 'Redo (alternative)' },
  { keys: ['Delete'], action: 'Delete the selected drawing' },
  { keys: ['Esc'], action: 'Cancel the drawing in progress, or deselect' },
];

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const toolRows: Row[] = TOOL_ORDER.flatMap((tool) => {
    const hint = shortcutHint(tool);
    if (hint === '') return [];
    return [{ keys: hint.split(' / '), action: TOOL_LABELS[tool] }];
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        aria-modal="true"
        className="flex max-h-[88vh] w-[min(720px,94vw)] flex-col rounded-xl border border-term-border bg-term-raised shadow-2xl shadow-black/70 ring-1 ring-white/[0.04]"
      >
        <header className="flex items-center gap-3 border-b border-term-border px-5 py-3.5">
          <h2 className="text-head font-semibold tracking-wide text-term-text">
            Keyboard shortcuts
          </h2>
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

        <div className="grid min-h-0 flex-1 gap-x-8 gap-y-4 overflow-y-auto px-4 py-3 sm:grid-cols-2">
          <Section title="Drawing tools" rows={toolRows} />
          <div className="flex flex-col gap-4">
            <Section title="Bar replay" rows={REPLAY_ROWS} />
            <Section title="Editing" rows={EDIT_ROWS} />
          </div>
        </div>

        <footer className="border-t border-term-border px-4 py-2">
          <p className="text-tiny text-term-muted">
            Alt+H and Alt+V place the line at the pointer immediately — no click
            needed. Shortcuts are ignored while you are typing in a field.
          </p>
        </footer>
      </div>
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section>
      <p className="mb-1.5 text-micro tracking-[0.01em] text-term-muted">
        {title}
      </p>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.action}
            className="flex items-center gap-3 border-b border-term-border/60 py-1.5 last:border-b-0"
          >
            <span className="flex flex-1 items-center gap-1">
              {row.keys.map((key, index) => (
                <span key={key} className="flex items-center gap-1">
                  {index > 0 ? (
                    <span className="text-tiny text-term-muted">
                      {key.startsWith('Alt') ? 'or' : '+'}
                    </span>
                  ) : null}
                  <kbd className="min-w-[24px] rounded-md border border-term-border-strong bg-term-bg px-1.5 py-0.5 text-center font-mono text-tiny text-term-dim">
                    {key}
                  </kbd>
                </span>
              ))}
            </span>
            <span className="flex-[2] text-small text-term-text">{row.action}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
