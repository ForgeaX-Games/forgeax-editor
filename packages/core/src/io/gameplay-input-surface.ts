import { GameplayInputSchema, type GameplayInput } from './gameplay-contract';

/** Host-owned input reaches the same canvas/UI DOM listeners as human input. */
export function createGameplayInputSurface(canvas: HTMLCanvasElement, root: HTMLElement) {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  const heldKeys = new Map<string, string>();
  const pointers = new Map<number, { target: Element; button: number; pointerType: string }>();
  let disposed = false;
  const keyIdentity = (value: string) => {
    if (/^Key[A-Z]$/.test(value)) return { key: value.slice(3).toLowerCase(), code: value };
    if (/^[a-z]$/i.test(value)) return { key: value, code: `Key${value.toUpperCase()}` };
    if (value === 'Space' || value === ' ') return { key: ' ', code: 'Space' };
    if (/^[0-9]$/.test(value)) return { key: value, code: `Digit${value}` };
    return { key: value, code: value };
  };
  return {
    async send(action: GameplayInput) {
      const parsed = GameplayInputSchema.safeParse(action);
      if (!parsed.success || disposed || !win || !canvas.isConnected) {
        return { ok: false as const, error: { code: 'surface-unavailable', hint: 'A live Play canvas and valid input are required.' } };
      }
      const input = parsed.data;
      if (input.type === 'key') {
        const { key, code } = keyIdentity(input.key);
        canvas.focus({ preventScroll: true });
        canvas.dispatchEvent(new win.KeyboardEvent(input.phase === 'down' ? 'keydown' : 'keyup', {
          key, code, bubbles: true, cancelable: true, repeat: input.phase === 'down' && heldKeys.has(key),
        }));
        if (input.phase === 'down') heldKeys.set(key, code);
        else heldKeys.delete(key);
      } else {
        const rect = canvas.getBoundingClientRect();
        const clientX = rect.left + input.x * rect.width / canvas.width;
        const clientY = rect.top + input.y * rect.height / canvas.height;
        const hit = doc.elementFromPoint(clientX, clientY);
        if (!hit || !(root === hit || root.contains(hit))) {
          return { ok: false as const, error: { code: 'input-outside-viewport', hint: 'Pointer coordinates must target the live game viewport.' } };
        }
        const pointerId = input.pointerId ?? 1;
        const phase = input.phase ?? 'move';
        const button = input.button === 'right' ? 2 : input.button === 'middle' ? 1 : 0;
        const held = pointers.get(pointerId);
        const target = held?.target ?? hit;
        target.dispatchEvent(new win.PointerEvent(`pointer${phase}`, {
          clientX, clientY, pointerId, pointerType: input.pointerType ?? 'mouse', button,
          buttons: phase === 'up' || phase === 'cancel' || (phase === 'move' && !held) ? 0 : button === 0 ? 1 : button === 1 ? 4 : 2,
          bubbles: true, cancelable: true,
        }));
        if (phase === 'down') pointers.set(pointerId, { target: hit, button, pointerType: input.pointerType ?? 'mouse' });
        if (phase === 'up' || phase === 'cancel') {
          if (phase === 'up' && pointers.get(pointerId)?.target === hit && button === 0) {
            hit.dispatchEvent(new win.MouseEvent('click', { clientX, clientY, button, bubbles: true, cancelable: true }));
          }
          pointers.delete(pointerId);
        }
      }
      return { ok: true as const };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (win) for (const [key, code] of heldKeys) canvas.dispatchEvent(new win.KeyboardEvent('keyup', { key, code, bubbles: true }));
      heldKeys.clear();
      if (win) for (const [pointerId, held] of pointers) held.target.dispatchEvent(new win.PointerEvent('pointercancel', { pointerId, pointerType: held.pointerType, button: held.button, buttons: 0, bubbles: true }));
      pointers.clear();
    },
  };
}
