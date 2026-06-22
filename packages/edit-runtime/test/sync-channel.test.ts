import { test, expect } from 'bun:test';
import { getPopoutPanel, getEditorRole } from '../src/core/sync-channel';

test('getPopoutPanel: recognizes each dockable panel from ?panel=', () => {
  expect(getPopoutPanel('?panel=inspector')).toBe('inspector');
  expect(getPopoutPanel('?panel=hierarchy&scene=fps')).toBe('hierarchy');
  expect(getPopoutPanel('?scene=fps&panel=assets')).toBe('assets');
  expect(getPopoutPanel('?panel=history')).toBe('history');
  expect(getPopoutPanel('?panel=capabilities')).toBe('capabilities');
  expect(getPopoutPanel('?panel=material')).toBe('material');
});

test('getPopoutPanel: main window (no/unknown panel) → null', () => {
  expect(getPopoutPanel('')).toBeNull();
  expect(getPopoutPanel('?scene=fps')).toBeNull();
  expect(getPopoutPanel('?panel=viewport')).toBeNull(); // viewport is not poppable
  expect(getPopoutPanel('?panel=')).toBeNull();
});

test('getEditorRole: popout iff a valid ?panel is present', () => {
  expect(getEditorRole('?panel=inspector')).toBe('popout');
  expect(getEditorRole('?scene=fps')).toBe('main');
  expect(getEditorRole('')).toBe('main');
});
