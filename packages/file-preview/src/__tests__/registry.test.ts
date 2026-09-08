import { test, expect } from 'bun:test';
import {
  registerFilePreviewRenderer,
  resolveFilePreviewRenderer,
  listFilePreviewRenderers,
} from '../registry';
import type { FilePreviewInput, FilePreviewRenderer } from '../types';

// These tests import the registry directly (never register-builtins), so the
// registry starts empty; each test cleans up via the disposers it receives.
const noopComponent: FilePreviewRenderer['component'] = () => null;

function input(overrides: Partial<FilePreviewInput> = {}): FilePreviewInput {
  return {
    path: 'a.ts', name: 'a.ts', family: 'code', ext: 'ts',
    mime: 'text/plain', size: 10, content: 'x', rawUrl: '/raw', ...overrides,
  };
}

test('resolve returns undefined when nothing matches', () => {
  const dispose = registerFilePreviewRenderer({ id: 't:never', match: () => false, component: noopComponent });
  try {
    expect(resolveFilePreviewRenderer(input())).toBeUndefined();
  } finally {
    dispose();
  }
});

test('higher priority wins', () => {
  const d1 = registerFilePreviewRenderer({ id: 't:lo', priority: 0, match: () => true, component: noopComponent });
  const d2 = registerFilePreviewRenderer({ id: 't:hi', priority: 100, match: () => true, component: noopComponent });
  try {
    expect(resolveFilePreviewRenderer(input())?.id).toBe('t:hi');
  } finally {
    d1(); d2();
  }
});

test('later registration wins on a priority tie', () => {
  const d1 = registerFilePreviewRenderer({ id: 't:first', match: () => true, component: noopComponent });
  const d2 = registerFilePreviewRenderer({ id: 't:second', match: () => true, component: noopComponent });
  try {
    expect(resolveFilePreviewRenderer(input())?.id).toBe('t:second');
  } finally {
    d1(); d2();
  }
});

test('re-registering the same id replaces the prior definition', () => {
  const d1 = registerFilePreviewRenderer({ id: 't:dup', match: () => false, component: noopComponent });
  const d2 = registerFilePreviewRenderer({ id: 't:dup', match: () => true, component: noopComponent });
  try {
    expect(listFilePreviewRenderers().filter((r) => r.id === 't:dup')).toHaveLength(1);
    expect(resolveFilePreviewRenderer(input())?.id).toBe('t:dup');
  } finally {
    d1(); d2();
  }
});

test('disposer removes exactly its registration', () => {
  const dispose = registerFilePreviewRenderer({ id: 't:tmp', match: () => true, component: noopComponent });
  expect(resolveFilePreviewRenderer(input())?.id).toBe('t:tmp');
  dispose();
  expect(resolveFilePreviewRenderer(input())).toBeUndefined();
});
