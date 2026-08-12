// mesh-preview-ownership.test.ts — STD-01/T0.3 architecture guard.
//
// A preview-only mini-world is allowed, but its canvas/createApp/World
// lifecycle must have one owner. Keep the React viewport and panels as shells.

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC_ROOT = resolve(import.meta.dir, '..');
const read = (relative: string): string => readFileSync(resolve(SRC_ROOT, relative), 'utf8');

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__') files.push(...sourceFiles(full));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

describe('STD-01 preview runtime ownership', () => {
  it('keeps createApp inside PreviewWorldService', () => {
    expect(read('preview-world/preview-world-service.ts')).toMatch(/\bcreateApp\s*\(/u);
    expect(read('viewport/MeshPreviewViewport.tsx')).not.toMatch(/\bcreateApp\s*\(/u);
  });

  it('keeps engine lifecycle out of the panel package', () => {
    const panelSource = readFileSync(
      resolve(SRC_ROOT, '../../panels/src/AssetEditors.tsx'),
      'utf8',
    );
    expect(panelSource).not.toMatch(/createApp|new\s+World|MeshPreviewViewport/u);
    expect(panelSource).toContain('getMeshPreview');
  });

  it('keeps editor createApp call sites on the known owner boundary', () => {
    // MaterialPreviewViewport is the pre-existing MI/base-material preview
    // debt, VfxPreviewViewport owns the VFX page preview, and play-assemble is
    // the separate Play runtime path; none is a Mesh preview owner. Any new
    // preview createApp call must land in a deliberate owner and update this
    // guard.
    const expected = new Set([
      'preview-world/preview-world-service.ts',
      'viewport/MaterialPreviewViewport.tsx',
      'viewport/VfxPreviewViewport.tsx',
      'viewport/ViewportComponent.tsx',
      'viewport/play-assemble.ts',
    ]);
    const actual = new Set<string>();
    for (const file of sourceFiles(SRC_ROOT)) {
      if (!/\bcreateApp\s*\(/u.test(stripComments(readFileSync(file, 'utf8')))) continue;
      actual.add(file.slice(SRC_ROOT.length + 1).replaceAll('\\', '/'));
    }
    expect(actual).toEqual(expected);
  });

  it('keeps preview state outside the authored operation path', () => {
    const service = read('preview-world/preview-world-service.ts');
    const assembly = read('preview-world/assemble-mesh-preview-world.ts');
    expect(stripComments(service)).not.toMatch(/gateway\.dispatch|saveDocToDisk|setAssetSelection/u);
    expect(stripComments(assembly)).not.toMatch(/gateway\.dispatch|saveDocToDisk|setAssetSelection|SceneDoc/u);
    expect(service).toContain('generation !== this.generation');
    expect(service).toContain('if (this.disposed) return;');
  });

  it('keeps Mesh, Material, and VFX previews on the shared preview profile', () => {
    const viewport = read('viewport/viewport.ts');
    expect(viewport).toContain("interaction?: 'full' | 'preview'");
    expect(viewport).toContain("canvas.dataset.fxKeyboardSurface = 'viewport-preview'");
    expect(viewport).toContain("canvas.addEventListener('keydown', onFlyKeyDown)");
    expect(viewport).toContain('if (!previewOnly) viewportBootInput.install(handleViewportKeyDown)');

    for (const owner of [
      'preview-world/preview-world-service.ts',
      'viewport/MaterialPreviewViewport.tsx',
      'viewport/VfxPreviewViewport.tsx',
    ]) {
      expect(read(owner), owner).toContain("interaction: 'preview'");
    }
  });
});
