import { test, expect } from 'bun:test';
import { decideHighlight, MAX_HIGHLIGHT_BYTES, MAX_HIGHLIGHT_LINES } from '../code-preview-policy';

test('no content is not highlightable', () => {
  expect(decideHighlight({ ext: 'ts', size: 10 })).toEqual({ highlight: false, reason: 'no-content' });
});

test('unknown language is not highlightable', () => {
  expect(decideHighlight({ ext: 'bin', size: 10, content: 'x' })).toEqual({ highlight: false, reason: 'unknown-language' });
});

test('known language under budget highlights', () => {
  const d = decideHighlight({ ext: 'ts', size: 10, content: 'const x = 1' });
  expect(d).toEqual({ highlight: true, lang: 'typescript', label: 'TypeScript' });
});

test('oversized by declared size skips highlight', () => {
  const d = decideHighlight({ ext: 'json', size: MAX_HIGHLIGHT_BYTES + 1, content: '{}' });
  expect(d).toEqual({ highlight: false, reason: 'too-large' });
});

test('oversized by content length skips highlight', () => {
  const big = 'a'.repeat(MAX_HIGHLIGHT_BYTES + 1);
  expect(decideHighlight({ ext: 'ts', size: 0, content: big })).toEqual({ highlight: false, reason: 'too-large' });
});

test('oversized by line count skips highlight', () => {
  const many = '\n'.repeat(MAX_HIGHLIGHT_LINES + 1);
  expect(decideHighlight({ ext: 'ts', size: 0, content: many })).toEqual({ highlight: false, reason: 'too-large' });
});
