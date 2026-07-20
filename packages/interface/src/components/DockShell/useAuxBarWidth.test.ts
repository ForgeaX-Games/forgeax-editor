import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const STORAGE_KEY = 'forgeax:auxbar-width';
const DEFAULT = 280;
const MIN = 200;
const MAX = 640;

// Bun caches the module across `it` blocks, so the zustand initializer runs
// exactly once per test process. Reset store width to a freshly-derived value
// in each beforeEach so tests remain independent and can seed localStorage
// pre-import to exercise the initializer's malformed-value path.
async function resetStore(): Promise<void> {
  const { useAuxBarWidth, __loadPersistedForTests } = await import('./useAuxBarWidth');
  useAuxBarWidth.setState({ width: __loadPersistedForTests() });
}

describe('useAuxBarWidth', () => {
  let registered = false;
  beforeEach(async () => {
    try { GlobalRegistrator.register(); registered = true; } catch { registered = false; }
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
  });
  afterEach(() => { if (registered) GlobalRegistrator.unregister(); });

  it('default width is 280 when nothing is persisted', async () => {
    await resetStore();
    const { useAuxBarWidth } = await import('./useAuxBarWidth');
    expect(useAuxBarWidth.getState().width).toBe(DEFAULT);
  });

  it('setWidth persists the value to localStorage', async () => {
    await resetStore();
    const { useAuxBarWidth } = await import('./useAuxBarWidth');
    useAuxBarWidth.getState().setWidth(320);
    expect(useAuxBarWidth.getState().width).toBe(320);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('320');
  });

  it('setWidth clamps below MIN', async () => {
    await resetStore();
    const { useAuxBarWidth } = await import('./useAuxBarWidth');
    useAuxBarWidth.getState().setWidth(50);
    expect(useAuxBarWidth.getState().width).toBe(MIN);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(MIN));
  });

  it('setWidth clamps above MAX', async () => {
    await resetStore();
    const { useAuxBarWidth } = await import('./useAuxBarWidth');
    useAuxBarWidth.getState().setWidth(2000);
    expect(useAuxBarWidth.getState().width).toBe(MAX);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(MAX));
  });

  it('tolerates malformed persisted values (NaN, missing) by falling back to default', async () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-number');
    await resetStore();
    const { useAuxBarWidth } = await import('./useAuxBarWidth');
    expect(useAuxBarWidth.getState().width).toBe(DEFAULT);
  });
});

