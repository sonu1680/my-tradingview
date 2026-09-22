'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  createHistory,
  pushHistory,
  redo as historyRedo,
  replacePresent,
  undo as historyUndo,
  type History,
} from '@/lib/drawings/history';
import type { Drawing } from '@/lib/drawings/types';

/**
 * The drawings state, with an undo stack wrapped around it.
 *
 * The whole point is that an undo step is a USER action, not a React state
 * change. A drag writes a new array on every mousemove; pushing each of those
 * would bury the real actions under two hundred pixel-sized entries. So the
 * gesture-shaped callers (`useDrawings` while dragging, the inspector while
 * typing) open a transaction, write their frames transiently, and close it —
 * and the transaction is what becomes the single entry.
 *
 * Transactions are REFCOUNTED: a second `beginTransaction` while one is open
 * keeps the outermost snapshot and only the matching outermost commit/abort
 * touches the stack. A commit or abort with nothing open is a no-op.
 */

type DrawingsSetter = Drawing[] | ((previous: Drawing[]) => Drawing[]);

interface OpenTransaction {
  depth: number;
  /** The present at the outermost `beginTransaction`; what an abort restores. */
  base: Drawing[];
}

/** The subset a child component needs to make its gesture one undo step. */
export interface DrawingHistoryControls {
  /** Apply a change WITHOUT an undo entry — mid-gesture frames only. */
  setDrawingsTransient: (next: DrawingsSetter) => void;
  /** Start a multi-step gesture; the state at this moment is what undo returns to. */
  beginTransaction: () => void;
  /** End it, pushing exactly ONE undo entry (a no-op if nothing changed). */
  commitTransaction: () => void;
  /** End it, restoring the state from `beginTransaction`, pushing NOTHING. */
  abortTransaction: () => void;
  undo: () => void;
  redo: () => void;
}

export interface DrawingHistory extends DrawingHistoryControls {
  drawings: Drawing[];
  /** Commit a change as ONE undoable step. */
  setDrawings: (next: DrawingsSetter) => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Seed from storage on mount: replaces the state and clears the history. */
  reset: (drawings: Drawing[]) => void;
}

function resolve(next: DrawingsSetter, previous: Drawing[]): Drawing[] {
  return typeof next === 'function' ? next(previous) : next;
}

/**
 * Drops one level of nesting. Returns the snapshot to act on, or null when the
 * transaction is still open (a nested level) or was never open at all.
 */
function closeTransaction(
  ref: RefObject<OpenTransaction | null>,
): Drawing[] | null {
  const open = ref.current;
  if (open === null) return null;
  if (open.depth > 1) {
    ref.current = { depth: open.depth - 1, base: open.base };
    return null;
  }
  ref.current = null;
  return open.base;
}

export function useDrawingHistory(): DrawingHistory {
  const [history, setHistory] = useState<History<Drawing[]>>(() =>
    createHistory<Drawing[]>([]),
  );

  // The callbacks are handed out once and must see the newest history; it is
  // mirrored into a box in an effect rather than read during render, the same
  // way `useDrawings` keeps its props current.
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  });

  const transactionRef = useRef<OpenTransaction | null>(null);

  const setDrawingsTransient = useCallback((next: DrawingsSetter) => {
    setHistory((current) =>
      replacePresent(current, resolve(next, current.present)),
    );
  }, []);

  const setDrawings = useCallback(
    (next: DrawingsSetter) => {
      // Inside a gesture there is no such thing as a separate step: the frame
      // folds into the one entry the pending commit will push.
      if (transactionRef.current !== null) {
        setDrawingsTransient(next);
        return;
      }
      setHistory((current) =>
        pushHistory(current, resolve(next, current.present)),
      );
    },
    [setDrawingsTransient],
  );

  const beginTransaction = useCallback(() => {
    const open = transactionRef.current;
    transactionRef.current =
      open === null
        ? { depth: 1, base: historyRef.current.present }
        : { depth: open.depth + 1, base: open.base };
  }, []);

  const commitTransaction = useCallback(() => {
    const base = closeTransaction(transactionRef);
    if (base === null) return;
    setHistory((current) =>
      // Put the pre-gesture value back as the present, then push what the
      // gesture left behind over it: exactly one entry. When the gesture
      // changed nothing both calls return the same history, so nothing lands.
      pushHistory(replacePresent(current, base), current.present),
    );
  }, []);

  const abortTransaction = useCallback(() => {
    const base = closeTransaction(transactionRef);
    if (base === null) return;
    setHistory((current) => replacePresent(current, base));
  }, []);

  // Undoing halfway through a drag would leave the gesture writing frames over
  // a state it never started from, so the stack is frozen while one is open.
  const undo = useCallback(() => {
    if (transactionRef.current !== null) return;
    setHistory((current) => historyUndo(current));
  }, []);

  const redo = useCallback(() => {
    if (transactionRef.current !== null) return;
    setHistory((current) => historyRedo(current));
  }, []);

  const reset = useCallback((drawings: Drawing[]) => {
    transactionRef.current = null;
    setHistory(createHistory(drawings));
  }, []);

  return useMemo(
    () => ({
      drawings: history.present,
      setDrawings,
      setDrawingsTransient,
      beginTransaction,
      commitTransaction,
      abortTransaction,
      undo,
      redo,
      canUndo: historyCanUndo(history),
      canRedo: historyCanRedo(history),
      reset,
    }),
    [
      history,
      setDrawings,
      setDrawingsTransient,
      beginTransaction,
      commitTransaction,
      abortTransaction,
      undo,
      redo,
      reset,
    ],
  );
}
