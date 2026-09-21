import { expect, test } from 'bun:test';
import { playFailureMessage } from '../play-failure-notice';

test('missing camera gives authoring guidance instead of a GPU repair instruction', () => {
  const error = { code: 'render-system-no-camera', hint: 'low-level camera contract' };
  expect(playFailureMessage(error, 'en')).toContain('game scene has no camera');
  expect(playFailureMessage(error, 'zh')).toContain('请添加相机');
  expect(playFailureMessage(error, 'en')).not.toContain('GPU');
});

test('other Play failures keep their actionable hint and tolerate absent details', () => {
  expect(playFailureMessage({ hint: 'Asset could not be loaded.' }, 'en')).toContain('Asset could not be loaded.');
  expect(playFailureMessage(undefined, 'en')).toBe('Play could not start.');
});


test('nested Pack load diagnostics precede compact source paths', () => {
  const sourcePath = '/private/tmp/runtime/host-games/example/assets/scene.pack.ts';
  const error = {
    code: 'catalog-scan-failed', hint: 'Catalog failed',
    cause: {
      code: 'pack-source-load-failed', hint: 'Repair the module',
      detail: { sourcePath, diagnostic: 'AssetGuidParser is not defined' },
    },
  };
  expect(playFailureMessage(error, 'en')).toBe(
    'Play could not start: AssetGuidParser is not defined · [pack-source-load-failed] · assets/scene.pack.ts',
  );
  expect(playFailureMessage(error, 'en', true)).toContain(sourcePath);
});

test('closure mismatch identifies unused declarations without hiding the failure code', () => {
  const error = {
    code: 'pack-source-external-closure-mismatch', hint: 'Repair external references',
    detail: { sourcePath: 'C:\\project\\assets\\scene.pack.ts', unusedDeclaredGuids: ['old-sphere', 'old-player'] },
  };
  const message = playFailureMessage(error, 'en');
  expect(message).toContain('Unused asset declarations: old-sphere, old-player');
  expect(message).toContain('[pack-source-external-closure-mismatch] · assets/scene.pack.ts');
});

test('cyclic causes are bounded and preserve diagnostics', () => {
  const error: { hint: string; cause?: unknown } = { hint: 'Asset could not be loaded.' };
  error.cause = error;
  expect(playFailureMessage(error, 'en')).toContain('Asset could not be loaded.');
});
