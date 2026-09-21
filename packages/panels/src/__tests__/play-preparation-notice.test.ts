import { expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createPlayPreparation } from '../../../edit-runtime/src/viewport/play-preparation';
import { createPlayFailureReporter, installPlayFailureNotice } from '../../../edit-runtime/src/viewport/play-failure-notice';

if (typeof document === 'undefined') GlobalRegistrator.register();

function fixture() {
  const container = document.createElement('div');
  const notice = installPlayFailureNotice(container, () => 'en');
  const errors: unknown[] = [];
  const report = createPlayFailureReporter({ fail: error => errors.push(error), notice });
  return { container, notice, errors, report };
}

test('preparation rejection reaches visible notice and preserves the original diagnostic; retry succeeds', async () => {
  const f = fixture();
  const diagnostic = { code: 'produce-failed', cause: {
    code: 'pack-source-external-closure-mismatch',
    hint: 'Repair the declared GUIDs and rebuild.', detail: { sourcePath: 'assets/scene.pack.ts' },
  } };
  let broken = true;
  let plays = 0;
  const prep = createPlayPreparation(async () => { if (broken) throw diagnostic; });
  prep.attach({ prepareScene: async () => {}, failed: f.report,
    play: () => { plays++; f.notice.clear(); return { ok: true }; }, stop: () => {}, isPlaying: () => false });
  const result = await prep.play().completion;
  expect(result).toMatchObject({ ok: false, error: diagnostic });
  expect(plays).toBe(0);
  const node = f.container.querySelector<HTMLElement>('[role=status]')!;
  expect(node.style.display).toBe('flex');
  expect(node.textContent).toContain('Repair the declared GUIDs and rebuild. · [pack-source-external-closure-mismatch] · assets/scene.pack.ts');
  expect(f.errors[0]).toMatchObject({ code: 'play-assemble-failed', cause: { code: 'produce-failed', details: diagnostic } });
  broken = false;
  expect(await prep.play().completion).toEqual({ ok: true });
  expect(plays).toBe(1);
  expect(node.style.display).toBe('none');
  prep.dispose(); f.notice.dispose();
});

test('Stop during preparation does not show a failure or start a late Play', async () => {
  const f = fixture();
  let resolve!: () => void;
  const barrier = new Promise<void>(done => { resolve = done; });
  let plays = 0;
  const prep = createPlayPreparation(async () => barrier);
  prep.attach({ prepareScene: async () => {}, failed: f.report,
    play: () => { plays++; return { ok: true }; }, stop: () => {}, isPlaying: () => false });
  const run = prep.play();
  prep.stop(); resolve();
  expect((await run.completion)?.ok).toBe(false);
  expect(f.errors).toEqual([]);
  expect(plays).toBe(0);
  expect(f.container.querySelector<HTMLElement>('[role=status]')!.style.display).toBe('none');
  prep.dispose(); f.notice.dispose();
});

test('failed bootstrap reporter returns failure instead of a successful no-op', () => {
  const f = fixture();
  const original = new Error('Host session failed to initialize');
  expect(f.report(original)).toMatchObject({ ok: false, error: { code: 'play-assemble-failed', details: original } });
  expect(f.container.textContent).toContain(original.message);
  f.notice.dispose();
});
