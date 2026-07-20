/**
 * Unit tests for the BUILTIN_WORKBENCHES declarative layout table.
 *
 * Verifies that:
 *   - Each entry's `layout` is a well-formed SerializedDockview
 *     (structure asserted in buildDefault-layout.test.ts).
 *   - `buildDefault` hands `api.fromJSON` the filtered layout for known
 *     ids and falls back to the AI layout for unknown / custom workbench
 *     ids (so the AI branch and the custom fallback are collapsed into
 *     one implementation).
 *   - Region filtering (via `filterLayoutByMembership`) drops panels the
 *     region does not own, without breaking the rest of the tree.
 *
 * The DockviewApi mock here is minimal — only `fromJSON` is exercised,
 * since the imperative addPanel path has been retired.
 */
import { describe, it, expect } from 'bun:test';
import type { DockviewApi } from 'dockview';
import { buildDefault } from '../DockRegion';
import { BUILTIN_WORKBENCHES, filterLayoutByMembership } from '../builtinWorkbenches';

interface FakeApi {
  api: DockviewApi;
  captured: unknown[];
}

function makeFakeApi(): FakeApi {
  const captured: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = { fromJSON: (data: unknown) => { captured.push(data); } } as any;
  return { api, captured };
}

/** Collect every panel id referenced by any leaf in the grid. */
function leafPanelIds(layout: { grid: { root: unknown } }): string[] {
  const ids: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { type?: string; data?: unknown };
    if (node.type === 'leaf') {
      const d = node.data as { views?: string[] };
      d?.views?.forEach((v) => ids.push(v));
    } else if (node.type === 'branch') {
      (node.data as unknown[]).forEach(walk);
    }
  };
  walk(layout.grid.root);
  return ids;
}

describe('BUILTIN_WORKBENCHES — declarative layout table', () => {
  it("'scene' fallback stays interface-neutral", () => {
    const ids = leafPanelIds(BUILTIN_WORKBENCHES.scene.layout);
    expect(new Set(ids)).toEqual(new Set(['viewport', 'chat']));
    expect(ids.some((id) => id.startsWith('ep:'))).toBe(false);
  });

  it("buildDefault('scene') prefers a host-provided editor layout", () => {
    const { api, captured } = makeFakeApi();
    const hostLayout = {
      grid: {
        width: 320,
        height: 240,
        root: { type: 'leaf', data: { views: ['ep:hierarchy'], activeView: 'ep:hierarchy', id: 'g-editor' } },
      },
      panels: {
        'ep:hierarchy': { id: 'ep:hierarchy', contentComponent: 'ep:hierarchy', title: 'Hierarchy' },
      },
    } as unknown as import('dockview').SerializedDockview;
    buildDefault(api, 'scene', () => true, hostLayout);
    expect(leafPanelIds(captured[0] as { grid: { root: unknown } })).toEqual(['ep:hierarchy']);
  });

  it("'ai' layout is exactly [tools, main, chat]", () => {
    expect(new Set(leafPanelIds(BUILTIN_WORKBENCHES.ai.layout))).toEqual(
      new Set(['tools', 'main', 'chat']),
    );
  });

  it("'ai' respects filterLayoutByMembership — chat filtered out leaves [tools, main]", () => {
    const filtered = filterLayoutByMembership(BUILTIN_WORKBENCHES.ai.layout, (id) => id !== 'chat');
    expect(filtered).not.toBeNull();
    expect(new Set(leafPanelIds(filtered!))).toEqual(new Set(['tools', 'main']));
  });

  it("buildDefault('ai') hands the AI layout (filtered) to api.fromJSON", () => {
    const { api, captured } = makeFakeApi();
    buildDefault(api, 'ai', () => true);
    expect(captured.length).toBe(1);
    expect(new Set(leafPanelIds(captured[0] as { grid: { root: unknown } }))).toEqual(
      new Set(['tools', 'main', 'chat']),
    );
  });

  it("buildDefault('unknown-custom-id') falls through to the AI layout", () => {
    const a = makeFakeApi();
    const b = makeFakeApi();
    buildDefault(a.api, 'unknown-custom-id', () => true);
    buildDefault(b.api, 'ai', () => true);
    // Custom workbenches share the AI three-panel default (they were
    // byte-identical branches before this refactor).
    expect(new Set(leafPanelIds(a.captured[0] as { grid: { root: unknown } }))).toEqual(
      new Set(leafPanelIds(b.captured[0] as { grid: { root: unknown } })),
    );
  });

  it('buildDefault skips fromJSON when nothing survives the isMember filter', () => {
    const { api, captured } = makeFakeApi();
    buildDefault(api, 'ai', () => false);
    expect(captured.length).toBe(0);
  });
});
