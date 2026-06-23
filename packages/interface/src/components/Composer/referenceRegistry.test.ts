/**
 * Safety net for the reference (pill) system — the contract that used to break
 * silently when a CSS class was renamed or a data-* dropped. Each test builds a
 * real DOM node (happy-dom) and asserts buildReferenceFor matches it and
 * produces the expected pill kind/icon/detail. If someone removes a selector or
 * forgets a data attribute, this fails loudly.
 *
 * Run: `bun test src/components/Composer/referenceRegistry.test.ts`
 */
import { describe, it, expect } from 'bun:test';
import {
  buildReferenceFor,
  buildPillFromTarget,
  buildEntityPill,
  buildAssetPill,
  buildComponentPill,
  REFERENCE_LABEL,
  REFERENCE_REGISTRY,
} from './referenceRegistry';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html.trim();
  return host.firstElementChild as HTMLElement;
}

describe('referenceRegistry — label', () => {
  it('has the canonical single label', () => {
    expect(REFERENCE_LABEL).toBe('引用到 Chat');
  });
});

describe('buildReferenceFor — DOM units', () => {
  const cases: Array<{ name: string; html: string; kind: string; icon: string; detailIncludes: string }> = [
    { name: 'file', html: `<div class="fp-row file" data-fp-path="games/x/main.ts"><span class="fp-name">main.ts</span></div>`, kind: 'file', icon: '📄', detailIncludes: 'main.ts' },
    { name: 'dir', html: `<div class="fp-row dir"><span class="fp-name">src</span></div>`, kind: 'dir', icon: '📁', detailIncludes: 'src' },
    { name: 'agent-card', html: `<div class="agent-card" data-agent-id="iori" data-role="pillar"><span class="ac-name">Iori★</span></div>`, kind: 'agent', icon: '🤝', detailIncludes: '@iori' },
    { name: 'wm-agent-card', html: `<div class="wm-agent-card" data-agent-id="suzu" data-agent-name="Suzu"></div>`, kind: 'agent', icon: '🤝', detailIncludes: '@suzu' },
    { name: 'ws-icon-btn', html: `<button class="ws-icon-btn" data-plugin-id="@x/wb-character" aria-label="角色"></button>`, kind: 'tool', icon: '🔧', detailIncludes: 'wb-character' },
    { name: 'preview-toolbar', html: `<div class="preview-toolbar" data-game-slug="sector-strike"></div>`, kind: 'game', icon: '🎮', detailIncludes: 'sector-strike' },
    { name: 'console-row', html: `<div class="console-row">RhiError: boom</div>`, kind: 'log', icon: '📜', detailIncludes: 'RhiError' },
    { name: 'workspace-tab', html: `<button class="mode-tab" data-ws-id="ws-abc" data-ws-name="Workspace 1"></button>`, kind: 'tool', icon: '🗂', detailIncludes: 'Workspace 1' },
    { name: 'game-row', html: `<div class="tb-game-row" data-game-slug="rogue"></div>`, kind: 'game', icon: '🎮', detailIncludes: 'rogue' },
    { name: 'session-row', html: `<div class="tb-game-row" data-session-id="sid123" data-session-name="sess"></div>`, kind: 'tool', icon: '💬', detailIncludes: 'sid123' },
    { name: 'chat-msg', html: `<div class="kc-text">你好世界</div>`, kind: 'log', icon: '💭', detailIncludes: '你好世界' },
    { name: 'user-msg', html: `<div class="user-bubble">问个问题</div>`, kind: 'log', icon: '🧑', detailIncludes: '问个问题' },
    { name: 'bus-plugin', html: `<div data-plugin-id="@x/model-anthropic">model</div>`, kind: 'tool', icon: '🔌', detailIncludes: 'model-anthropic' },
  ];

  for (const c of cases) {
    it(`matches ${c.name} → ${c.kind} ${c.icon}`, () => {
      const node = el(c.html);
      const ref = buildReferenceFor(node);
      expect(ref).not.toBeNull();
      expect(ref!.pill.kind).toBe(c.kind as never);
      expect(ref!.pill.icon).toBe(c.icon);
      expect(ref!.pill.detail).toContain(c.detailIncludes);
    });
  }

  it('matches a nested child via closest()', () => {
    const node = el(`<div class="fp-row file" data-fp-path="a/b.ts"><span class="fp-name"><i class="x">b.ts</i></span></div>`);
    const inner = node.querySelector('i')!;
    const ref = buildReferenceFor(inner);
    expect(ref?.pill.kind).toBe('file');
  });

  it('returns null for an unregistered element', () => {
    expect(buildReferenceFor(el(`<div class="totally-random"></div>`))).toBeNull();
    expect(buildPillFromTarget(el(`<div class="totally-random"></div>`))).toBeNull();
  });

  it('skips a matched selector when its required data-* is missing', () => {
    // .mode-tab matches but has no data-ws-id → build returns null → no ref.
    const node = el(`<button class="mode-tab"></button>`);
    expect(node.matches('.mode-tab[data-ws-id]')).toBe(false); // selector itself requires the attr
    expect(buildReferenceFor(node)).toBeNull();
  });

  it('ws-icon-btn wins over the generic [data-plugin-id] descriptor', () => {
    // a ws-icon-btn also carries data-plugin-id; the specific descriptor (earlier
    // in the list) must win, and the generic one self-excludes inside .ws-icon-btn.
    const node = el(`<button class="ws-icon-btn" data-plugin-id="@x/p" aria-label="P"></button>`);
    const ref = buildReferenceFor(node);
    expect(ref?.descriptor.kind).toBe('wb-plugin');
    expect(ref?.pill.icon).toBe('🔧'); // not 🔌
  });

  it('copy items are exposed where declared', () => {
    const node = el(`<div class="tb-game-row" data-game-slug="rogue"></div>`);
    const ref = buildReferenceFor(node)!;
    const copies = ref.descriptor.copy?.(ref.el) ?? [];
    expect(copies).toEqual([{ label: '复制 slug', text: 'rogue' }]);
  });

  it('every descriptor has a unique kind', () => {
    const kinds = REFERENCE_REGISTRY.map((d) => d.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe('editor-iframe pill builders', () => {
  it('entity pill', () => {
    const p = buildEntityPill({ id: 62, name: 'Pillar 4', components: ['Transform', 'Light'] });
    expect(p.icon).toBe('🎯');
    expect(p.detail).toContain('id=62');
    expect(p.detail).toContain('components=[Transform, Light]');
  });
  it('asset pill', () => {
    const p = buildAssetPill({ guid: 'abcd1234efgh', name: 'rock', assetKind: 'mesh' });
    expect(p.icon).toBe('🧱');
    expect(p.detail).toContain('guid=abcd1234efgh');
  });
  it('component pill', () => {
    const p = buildComponentPill({ entityId: 5, entityName: 'Lamp', comp: 'Light', value: { intensity: 2 } });
    expect(p.icon).toBe('🔧');
    expect(p.display).toBe('Lamp.Light');
    expect(p.detail).toContain('"intensity": 2');
  });
});
