// splitter-css-var.test.ts — pins the CSS-variable isolation contract for the
// content-browser source-panel splitter. The key invariant: the panel width is
// driven by a CSS variable (`--cb-src-w`) on the PARENT container, not by a
// React-controlled inline `style.width` on the panel itself. This ensures that
// imperative drag updates (via `splitRef.current.style.setProperty`) cannot be
// reverted by React re-renders (which was the original bug).
//
// These are structural / contract tests — they validate naming conventions,
// clamping logic, and the CSS variable pattern without requiring a full browser
// DOM or React render tree.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(import.meta.dir, 'content-browser.css');
const css = readFileSync(CSS_PATH, 'utf-8');

const TSX_PATH = resolve(import.meta.dir, 'ContentBrowser.tsx');
const tsx = readFileSync(TSX_PATH, 'utf-8');

describe('splitter: CSS-variable isolation contract', () => {
  it('CSS reads --cb-src-w in .cb-source-panel flex rule', () => {
    expect(css).toContain('var(--cb-src-w');
  });

  it('CSS does NOT have a fixed flex-basis that would override the variable', () => {
    // The legacy `flex: 0 0 170px` in theme.css was the root cause;
    // content-browser.css must not reintroduce a fixed basis.
    const panelBlock = css.slice(
      css.indexOf('.cb-source-panel'),
      css.indexOf('}', css.indexOf('.cb-source-panel')) + 1,
    );
    // Should contain var(--cb-src-w) in flex, NOT a hardcoded px basis
    expect(panelBlock).toContain('var(--cb-src-w');
    expect(panelBlock).not.toMatch(/flex:\s*0\s+0\s+\d+px/);
  });

  it('TSX sets --cb-src-w on cb-split parent, not on cb-source-panel', () => {
    // The variable must be set on the parent so React's controlled style
    // and imperative setProperty target the SAME element (no conflict).
    expect(tsx).toContain("'--cb-src-w'");
    expect(tsx).toContain('splitRef');
    expect(tsx).toContain("style.setProperty('--cb-src-w'");
  });

  it('TSX does NOT set controlled style.width on source panel', () => {
    // If the panel div has a React-controlled width, re-renders would
    // revert the imperative drag — the original bug.
    const panelLine = tsx.split('\n').find(l =>
      l.includes('cb-source-panel') && l.includes('style='),
    );
    expect(panelLine).toBeUndefined();
  });

  it('clamping constants match CSS min-width / max-width', () => {
    // Content-browser.css and ContentBrowser.tsx should agree on bounds.
    const cssMin = css.match(/\.cb-source-panel[\s\S]*?min-width:\s*(\d+)px/);
    const cssMax = css.match(/\.cb-source-panel[\s\S]*?max-width:\s*(\d+)px/);
    expect(cssMin).not.toBeNull();
    expect(cssMax).not.toBeNull();

    // TSX clamp: Math.min(640, Math.max(140, …))
    expect(tsx).toContain('Math.min(640');
    expect(tsx).toContain('Math.max(140');

    expect(Number(cssMin![1])).toBe(140);
    expect(Number(cssMax![1])).toBe(640);
  });
});

describe('splitter: ResizeHandle shared component', () => {
  const HANDLE_PATH = resolve(import.meta.dir, '../../core/src/ui/resize-handle.tsx');
  const handleSrc = readFileSync(HANDLE_PATH, 'utf-8');

  it('exports useLocalSize', () => {
    expect(handleSrc).toContain('export function useLocalSize');
  });

  it('exports ResizeHandle', () => {
    expect(handleSrc).toContain('export function ResizeHandle');
  });

  it('ResizeHandle supports onDragEnd callback', () => {
    expect(handleSrc).toContain('onDragEnd');
  });

  it('uses pointer capture for reliable drag', () => {
    expect(handleSrc).toContain('setPointerCapture');
    expect(handleSrc).toContain('releasePointerCapture');
  });

  it('sets col-resize cursor during drag', () => {
    expect(handleSrc).toContain('col-resize');
  });

  it('persists to localStorage', () => {
    expect(handleSrc).toContain('localStorage.setItem');
    expect(handleSrc).toContain('localStorage.getItem');
  });
});
