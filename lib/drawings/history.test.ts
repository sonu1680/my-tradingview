import { describe, expect, it } from 'vitest';

import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redo,
  replacePresent,
  undo,
  type History,
} from '@/lib/drawings/history';

/** A non-trivial `T`: this will hold `Drawing[]` in practice. */
interface Shape {
  id: string;
  points: Array<{ x: number; y: number }>;
}

const shapes = (...ids: string[]): Shape[] =>
  ids.map((id, i) => ({ id, points: [{ x: i, y: i * 2 }] }));

describe('HISTORY_LIMIT', () => {
  it('is 100', () => {
    expect(HISTORY_LIMIT).toBe(100);
  });
});

describe('createHistory', () => {
  it('starts with an empty past and future', () => {
    const h = createHistory('a');
    expect(h).toEqual({ past: [], present: 'a', future: [] });
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
});

describe('pushHistory', () => {
  it('moves the present into the past and clears the future', () => {
    const h = pushHistory(createHistory('a'), 'b');
    expect(h.past).toEqual(['a']);
    expect(h.present).toBe('b');
    expect(h.future).toEqual([]);
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
  });

  it('returns the SAME object when next is reference-equal to the present', () => {
    const present = shapes('a');
    const h = createHistory(present);
    expect(pushHistory(h, present)).toBe(h);
  });

  it('does NOT deep-compare: an equal-but-distinct value is a real push', () => {
    const h = createHistory(shapes('a'));
    const next = shapes('a');
    expect(next).toEqual(h.present);
    const pushed = pushHistory(h, next);
    expect(pushed).not.toBe(h);
    expect(pushed.past).toHaveLength(1);
    expect(pushed.present).toBe(next);
  });

  it('discards the redo branch when pushing after an undo', () => {
    let h = createHistory('a');
    h = pushHistory(h, 'b');
    h = pushHistory(h, 'c');
    h = undo(h);
    expect(h.present).toBe('b');
    expect(h.future).toEqual(['c']);

    h = pushHistory(h, 'd');
    expect(h.present).toBe('d');
    expect(h.future).toEqual([]);
    expect(h.past).toEqual(['a', 'b']);
    expect(canRedo(h)).toBe(false);
  });
});

describe('replacePresent', () => {
  it('changes the present but leaves past and future identical', () => {
    let h = createHistory('a');
    h = pushHistory(h, 'b');
    h = undo(h); // past: ['a'] -> [], future: ['b']; then push again for both stacks
    h = pushHistory(h, 'c'); // past: ['a'], future: []
    h = pushHistory(h, 'd'); // past: ['a', 'c']
    h = undo(h); // past: ['a'], present: 'c', future: ['d']

    const replaced = replacePresent(h, 'c2');
    expect(replaced.present).toBe('c2');
    expect(replaced.past).toBe(h.past);
    expect(replaced.future).toBe(h.future);
    expect(replaced.past).toEqual(['a']);
    expect(replaced.future).toEqual(['d']);
  });

  it('returns the SAME object when next is reference-equal to the present', () => {
    const present = shapes('a');
    const h = pushHistory(createHistory(shapes('z')), present);
    expect(replacePresent(h, present)).toBe(h);
  });

  it('does not make the replaced frame undoable', () => {
    const h = replacePresent(createHistory('a'), 'a-dragging');
    expect(canUndo(h)).toBe(false);
    expect(h.past).toEqual([]);
  });
});

describe('undo / redo', () => {
  it('undo restores the previous present, redo returns to the pushed one', () => {
    const h0 = createHistory('a');
    const h1 = pushHistory(h0, 'b');

    const undone = undo(h1);
    expect(undone.present).toBe('a');
    expect(undone.past).toEqual([]);
    expect(undone.future).toEqual(['b']);

    const redone = redo(undone);
    expect(redone.present).toBe('b');
    expect(redone.past).toEqual(['a']);
    expect(redone.future).toEqual([]);
  });

  it('round-trips in order across several pushes', () => {
    let h = createHistory('a');
    h = pushHistory(h, 'b');
    h = pushHistory(h, 'c');

    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(h.past).toEqual([]);
    expect(h.future).toEqual(['b', 'c']);

    h = redo(h);
    expect(h.present).toBe('b');
    h = redo(h);
    expect(h.present).toBe('c');
    expect(h.past).toEqual(['a', 'b']);
    expect(h.future).toEqual([]);
  });

  it('returns the SAME object when there is nothing to undo or redo', () => {
    const h = createHistory('a');
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);

    const pushed = pushHistory(h, 'b');
    expect(redo(pushed)).toBe(pushed);

    const undone = undo(pushed);
    expect(undo(undone)).toBe(undone);
  });

  it('redo keeps the entry it just appended even at the limit', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 3; i += 1) h = pushHistory(h, i, 3);
    expect(h.past).toEqual([0, 1, 2]);

    h = undo(h); // past: [0, 1], present: 2, future: [3]
    h = redo(h);
    expect(h.present).toBe(3);
    expect(h.past).toEqual([0, 1, 2]);
    expect(h.future).toEqual([]);
  });
});

describe('the limit', () => {
  it('drops the OLDEST entries and keeps the most recent `limit`', () => {
    const limit = 3;
    let h = createHistory(0);
    for (let i = 1; i <= limit + 10; i += 1) h = pushHistory(h, i, limit);

    expect(h.present).toBe(13);
    expect(h.past).toHaveLength(limit);
    // 0..9 were dropped; the three most recent presents remain.
    expect(h.past).toEqual([10, 11, 12]);

    h = undo(h);
    expect(h.present).toBe(12);
    h = undo(h);
    expect(h.present).toBe(11);
    h = undo(h);
    expect(h.present).toBe(10);
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
  });

  it('defaults to HISTORY_LIMIT', () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 5; i += 1) h = pushHistory(h, i);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(HISTORY_LIMIT + 5 - HISTORY_LIMIT);
    expect(h.past[HISTORY_LIMIT - 1]).toBe(HISTORY_LIMIT + 4);
  });
});

describe('immutability', () => {
  it('never mutates its input', () => {
    let h: History<Shape[]> = createHistory(shapes('a'));
    h = pushHistory(h, shapes('a', 'b'));
    h = pushHistory(h, shapes('a', 'b', 'c'));
    h = undo(h);

    const snapshot = structuredClone(h) as History<Shape[]>;
    const assertUnchanged = () => expect(h).toEqual(snapshot);

    pushHistory(h, shapes('x'));
    assertUnchanged();
    pushHistory(h, shapes('x'), 1);
    assertUnchanged();
    replacePresent(h, shapes('y'));
    assertUnchanged();
    undo(h);
    assertUnchanged();
    redo(h);
    assertUnchanged();
    canUndo(h);
    canRedo(h);
    assertUnchanged();
  });

  it('is generic over object arrays', () => {
    const a = shapes('a');
    const b = shapes('a', 'b');
    const h = pushHistory(createHistory(a), b);
    expect(h.present).toBe(b);
    expect(h.past[0]).toBe(a);
    expect(undo(h).present).toBe(a);
  });
});
