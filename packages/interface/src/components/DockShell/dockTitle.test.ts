import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { isDockTitleHidden, setDockTitleHidden } from './dockTitle';

let registered = false;

beforeEach(() => {
  try { GlobalRegistrator.register(); registered = true; } catch { registered = false; }
});

afterEach(() => {
  if (registered) GlobalRegistrator.unregister();
});

describe('dock title visibility', () => {
  it('uses a panel single-tab preference as the default', () => {
    const group = document.createElement('div');
    group.innerHTML = '<section class="fx-panel" data-dock-single-tab="hideTitle"></section>';
    expect(isDockTitleHidden(group)).toBe(true);
  });

  it('explicitly restoring the title overrides the default preference', () => {
    const group = document.createElement('div');
    group.innerHTML = '<section class="fx-panel" data-dock-single-tab="hideTitle"></section>';
    setDockTitleHidden(group, false);
    expect(isDockTitleHidden(group)).toBe(false);
    expect(group.dataset.fxDockTitleState).toBe('visible');
  });

  it('can hide a normal single-panel group and restore it again', () => {
    const group = document.createElement('div');
    setDockTitleHidden(group, true);
    expect(isDockTitleHidden(group)).toBe(true);
    setDockTitleHidden(group, false);
    expect(isDockTitleHidden(group)).toBe(false);
  });
});
