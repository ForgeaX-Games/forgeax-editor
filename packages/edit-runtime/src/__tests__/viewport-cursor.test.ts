import { afterEach, describe, expect, it } from 'bun:test';
import { createViewportCursorCapture } from '../viewport/viewport-cursor';

type Listener = () => void;

function fakeDocument() {
  const listeners = new Map<string, Set<Listener>>();
  const doc = {
    pointerLockElement: null as unknown,
    exitPointerLock() {
      this.pointerLockElement = null;
      for (const fn of listeners.get('pointerlockchange') ?? []) fn();
    },
    addEventListener(type: string, fn: Listener) {
      const bucket = listeners.get(type) ?? new Set<Listener>();
      bucket.add(fn);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
  return doc;
}

function fakeCanvas(doc: ReturnType<typeof fakeDocument>) {
  const captured = new Set<number>();
  const canvas = {
    style: { cursor: 'crosshair' },
    setPointerCapture(pointerId: number) { captured.add(pointerId); },
    releasePointerCapture(pointerId: number) { captured.delete(pointerId); },
    hasPointerCapture(pointerId: number) { return captured.has(pointerId); },
  } as unknown as HTMLCanvasElement & { captured: Set<number> };
  canvas.captured = captured;
  return canvas;
}

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

describe('viewport cursor capture adapter', () => {
  it('hides the cursor and falls back to pointer capture when lock is unavailable', () => {
    const doc = fakeDocument();
    const canvas = fakeCanvas(doc);
    const restored: Array<{ x: number; y: number }> = [];
    const capture = createViewportCursorCapture(canvas, {
      document: doc as unknown as Document,
      restorePointer: (anchor) => restored.push(anchor),
    });
    disposers.push(() => capture.dispose());

    capture.begin(7, { x: 12, y: 20 });
    expect(capture.isActive()).toBe(true);
    expect(capture.isPointerLocked()).toBe(false);
    expect(canvas.style.cursor).toBe('none');
    expect(canvas.captured.has(7)).toBe(true);
    expect(capture.movement({ clientX: 20, clientY: 23 }, [12, 20])).toEqual([8, 3]);

    capture.end();
    expect(capture.isActive()).toBe(false);
    expect(canvas.style.cursor).toBe('crosshair');
    expect(canvas.captured.has(7)).toBe(false);
    expect(restored).toEqual([{ x: 12, y: 20 }]);
  });

  it('uses movementX/Y after pointer lock and reports external lock loss', () => {
    const doc = fakeDocument();
    const canvas = fakeCanvas(doc);
    let lost = 0;
    (canvas as unknown as { requestPointerLock: () => void }).requestPointerLock = () => {
      doc.pointerLockElement = canvas;
      doc.dispatch('pointerlockchange');
    };
    const capture = createViewportCursorCapture(canvas, {
      document: doc as unknown as Document,
      onLost: () => { lost += 1; },
    });
    disposers.push(() => capture.dispose());

    capture.begin(2, { x: 1, y: 2 });
    expect(capture.isPointerLocked()).toBe(true);
    expect(capture.movement({ clientX: 500, clientY: 500, movementX: -4, movementY: 9 }, [1, 2]))
      .toEqual([-4, 9]);

    doc.pointerLockElement = null;
    doc.dispatch('pointerlockchange');
    expect(lost).toBe(1);
  });

  it('falls back when the lock request throws and cleanup is idempotent', () => {
    const doc = fakeDocument();
    const canvas = fakeCanvas(doc);
    (canvas as unknown as { requestPointerLock: () => void }).requestPointerLock = () => {
      throw new Error('denied');
    };
    const capture = createViewportCursorCapture(canvas, { document: doc as unknown as Document });
    disposers.push(() => capture.dispose());

    capture.begin(3, { x: 0, y: 0 });
    capture.cancel();
    capture.cancel();
    expect(capture.isActive()).toBe(false);
    expect(canvas.style.cursor).toBe('crosshair');
    expect(canvas.captured.has(3)).toBe(false);
  });
});
