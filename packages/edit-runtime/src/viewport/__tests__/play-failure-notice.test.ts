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
