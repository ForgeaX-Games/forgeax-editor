import { describe, expect, it } from 'bun:test';
import type { DetachedWindowCapability } from '../../lib/platform';
import {
  canOpenPanelWindow,
  detachedDockPanelForSurface,
  openPanelWindow,
  pageRuntimeOwnsPanel,
  resolvePanelWindowing,
  shouldShowDetachedPlaceholder,
} from './panelWindowing';

const capability: DetachedWindowCapability = {
  createTarget: () => ({
    surface: { kind: 'panel', id: 'chat' },
    title: 'Chat',
    width: 480,
    height: 680,
    dockBehavior: 'close',
  }),
};

describe('openPanelWindow', () => {
  it('closes an ordinary dock tab only after the window opens successfully', async () => {
    let closed = 0;
    const opened = await openPanelWindow('chat-placement', capability, {
      closeDockPanel: () => { closed += 1; },
      detachSurface: async (surface, options) => {
        expect(surface).toEqual({ kind: 'panel', id: 'chat' });
        expect(options).toEqual({
          title: 'Chat',
          width: 480,
          height: 680,
          x: 12,
          y: 34,
        });
        return true;
      },
      position: { x: 12, y: 34 },
    });

    expect(opened).toBe(true);
    expect(closed).toBe(1);
    expect(detachedDockPanelForSurface({ kind: 'panel', id: 'chat' })).toBe('chat-placement');
  });

  it('returns false and leaves the dock tab open when the carrier fails', async () => {
    let closed = 0;
    const opened = await openPanelWindow('chat', capability, {
      closeDockPanel: () => { closed += 1; },
      detachSurface: async () => false,
    });

    expect(opened).toBe(false);
    expect(closed).toBe(0);
  });

  it('keeps an explicitly anchored panel and does not register it for reopen', async () => {
    let closed = 0;
    const anchored: DetachedWindowCapability = {
      createTarget: () => ({
        surface: { kind: 'plugin', id: '@demo/tool', instance: 'page-a::main' },
        title: 'Demo Tool',
        width: 960,
        height: 720,
        dockBehavior: 'keep-anchor',
      }),
    };
    const opened = await openPanelWindow('main', anchored, {
      closeDockPanel: () => { closed += 1; },
      detachSurface: async () => true,
    });

    expect(opened).toBe(true);
    expect(closed).toBe(0);
    expect(detachedDockPanelForSurface({
      kind: 'plugin',
      id: '@demo/tool',
      instance: 'page-a::main',
    })).toBeUndefined();
  });

  it('gates affordances on both declaration and carrier availability', () => {
    expect(canOpenPanelWindow(capability, true)).toBe(true);
    expect(canOpenPanelWindow(capability, false)).toBe(false);
    expect(canOpenPanelWindow(undefined, true)).toBe(false);
  });

  it('derives the keep-anchor placeholder from the exact surface key', () => {
    const surface = { kind: 'plugin' as const, id: '@demo/tool', instance: 'page-a::main' };
    expect(shouldShowDetachedPlaceholder({ [encodeURIComponent('unrelated')]: true }, surface)).toBe(false);
    expect(shouldShowDetachedPlaceholder({
      'plugin:@demo/tool:instance=page-a%3A%3Amain': true,
    }, surface)).toBe(true);
  });
});

describe('resolvePanelWindowing', () => {
  const pageCapability: DetachedWindowCapability = {
    createTarget: () => ({
      surface: { kind: 'plugin', id: 'page' },
      title: 'Page',
      width: 800,
      height: 600,
      dockBehavior: 'keep-anchor',
    }),
  };
  const injectedCapability: DetachedWindowCapability = {
    createTarget: () => ({
      surface: { kind: 'plugin', id: 'injected' },
      title: 'Injected',
      width: 800,
      height: 600,
      dockBehavior: 'keep-anchor',
    }),
  };

  it('uses BASE capability for a same-name viewport Page placement', () => {
    expect(resolvePanelWindowing('viewport', {
      basePanelIds: new Set(['viewport']),
      baseWindowing: { viewport: capability },
      pageWindowing: { viewport: pageCapability },
      injectedWindowing: injectedCapability,
    })).toBe(capability);
  });

  it('keeps a BASE panel dock-only instead of falling through to Page', () => {
    expect(resolvePanelWindowing('info', {
      basePanelIds: new Set(['info']),
      baseWindowing: {},
      pageWindowing: { info: pageCapability },
      injectedWindowing: injectedCapability,
    })).toBeUndefined();
  });

  it('keeps ep:* dock-only regardless of Page or injected declarations', () => {
    expect(resolvePanelWindowing('ep:inspector', {
      basePanelIds: new Set(),
      baseWindowing: {},
      pageWindowing: { 'ep:inspector': pageCapability },
      injectedWindowing: injectedCapability,
    })).toBeUndefined();
  });

  it('uses an ordinary Page capability before an injected descriptor', () => {
    expect(resolvePanelWindowing('content', {
      basePanelIds: new Set(),
      baseWindowing: {},
      pageWindowing: { content: pageCapability },
      injectedWindowing: injectedCapability,
    })).toBe(pageCapability);
  });

  it('wraps only Page runtimes that survive BASE/editor component overrides', () => {
    const baseIds = new Set(['viewport', 'info']);
    const editorIds = ['inspector'];
    expect(pageRuntimeOwnsPanel('viewport', baseIds, editorIds)).toBe(false);
    expect(pageRuntimeOwnsPanel('ep:inspector', baseIds, editorIds)).toBe(false);
    expect(pageRuntimeOwnsPanel('ep:custom', baseIds, editorIds)).toBe(true);
    expect(pageRuntimeOwnsPanel('content', baseIds, editorIds)).toBe(true);
  });
});
