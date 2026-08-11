// template-catalog.ts — the editor-owned game template catalog.
//
// Both the standalone backend and Studio's server adapter consume this module.
// Hosts provide the engine/templates root because source and packaged layouts
// differ; the catalog rules themselves stay here as the editor SSOT.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const GAME_TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export interface GameTemplate {
  slug: string;
  name: string;
}

export async function listGameTemplates(engineTemplatesRoot: string): Promise<GameTemplate[]> {
  const entries = await readdir(engineTemplatesRoot, { withFileTypes: true });
  const templates: GameTemplate[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory()
      || entry.name.startsWith('.')
      || entry.name.startsWith('_')
      || entry.name === 'node_modules'
      || !GAME_TEMPLATE_SLUG_RE.test(entry.name)
    ) continue;
    try {
      const manifest = JSON.parse(await readFile(join(engineTemplatesRoot, entry.name, 'forge.json'), 'utf8')) as { name?: unknown };
      if (typeof manifest.name === 'string' && manifest.name.trim().length > 0) {
        templates.push({ slug: entry.name, name: manifest.name });
      }
    } catch {
      // A template without a valid forge.json is not launchable and is omitted.
    }
  }
  return templates.sort((a, b) => a.slug.localeCompare(b.slug));
}
