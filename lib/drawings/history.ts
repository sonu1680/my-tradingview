/**
 * Generic, pure undo/redo stack.
 *
 * No React, no DOM, no imports from anywhere in this repo — it is just data in,
 * data out, so it can be unit-tested and reused for any `T` (in practice
 * `Drawing[]`).
 *
 * Every operation returns a NEW object, except for the documented no-op cases,
 * which return the identical input reference so a React consumer can bail out
 * of a re-render with a cheap `===` check.
 */

/** Maximum number of undoable states retained in `past`. */
export const HISTORY_LIMIT = 100;

export interface History<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
}

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/**
 * Keep only the most recent `limit` entries, dropping from the FRONT so the
 * oldest states are the ones lost.
 */
function truncate<T>(past: readonly T[], limit: number): readonly T[] {
  if (limit <= 0) return [];
  if (past.length <= limit) return past;
  return past.slice(past.length - limit);
}

/**
 * Commit `next` as a new undoable state.
 *
 * Reference-equal to the current present => no-op (returns the same object) so
 * we never record empty undo entries. Deliberately NOT a deep comparison.
 *
 * A new action always discards the redo branch.
 */
export function pushHistory<T>(
  history: History<T>,
  next: T,
  limit: number = HISTORY_LIMIT,
): History<T> {
  if (next === history.present) return history;
  return {
    past: truncate([...history.past, history.present], limit),
    present: next,
    future: [],
  };
}

/**
 * Replace the present WITHOUT creating an undo entry — for mid-drag frames.
 * `past` and `future` are carried over untouched (same array references).
 */
export function replacePresent<T>(history: History<T>, next: T): History<T> {
  if (next === history.present) return history;
  return { past: history.past, present: next, future: history.future };
}

export function undo<T>(history: History<T>): History<T> {
  const { past, present, future } = history;
  if (past.length === 0) return history;
  return {
    past: past.slice(0, past.length - 1),
    present: past[past.length - 1],
    future: [present, ...future],
  };
}

export function redo<T>(history: History<T>): History<T> {
  const { past, present, future } = history;
  if (future.length === 0) return history;
  // No re-truncation here: redo must not drop the entry it just appended.
  return {
    past: [...past, present],
    present: future[0],
    future: future.slice(1),
  };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}
