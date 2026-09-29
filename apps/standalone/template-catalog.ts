// template-catalog.ts — the editor-owned game template catalog.
//
// Both the standalone backend and Studio's server adapter consume this module.
// Hosts provide the engine/templates root because source and packaged layouts
// differ; the catalog rules themselves stay here as the editor SSOT.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const GAME_TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export interface GameTemplate {
  slug: string;
  name: string;
}

export interface LaunchableGameTemplate extends GameTemplate {
  directory: string;
  manifest: Record<string, unknown>;
}

function confinedFile(templateDir: string, relativePath: string): boolean {
  if (!relativePath || relativePath !== relativePath.trim() || isAbsolute(relativePath)) return false;
  const resolved = resolve(templateDir, relativePath);
  return resolved.startsWith(`${templateDir}${sep}`)
    && existsSync(resolved)
    && statSync(resolved).isFile();
}

/**
 * The single launchability contract shared by the catalog and every host that
 * materializes a template. Supporting both schemas keeps legacy `entry`
 * projects working while admitting current plugin/defaultScene projects.
 */
export function resolveLaunchableGameTemplate(
  engineTemplatesRoot: string,
  slug: string,
): LaunchableGameTemplate | null {
  if (!GAME_TEMPLATE_SLUG_RE.test(slug)) return null;
  const templatesRoot = resolve(engineTemplatesRoot);
  const directory = resolve(templatesRoot, slug);
  if (!directory.startsWith(`${templatesRoot}${sep}`)) return null;

  try {
    if (!statSync(directory).isDirectory()) return null;
    const manifest = JSON.parse(readFileSync(join(directory, 'forge.json'), 'utf8')) as Record<string, unknown>;
    if (manifest === null || typeof manifest !== 'object') return null;
    const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
    if (!name) return null;

    const legacyEntry = manifest.entry;
    const legacyLaunchable = typeof legacyEntry === 'string'
      && confinedFile(directory, legacyEntry);

    const plugins = manifest.plugins;
    const pluginLaunchable = typeof manifest.id === 'string'
      && manifest.id.trim().length > 0
      && Array.isArray(plugins)
      && plugins.every((plugin) => {
        if (plugin === null || typeof plugin !== 'object') return false;
        const pluginName = (plugin as { name?: unknown }).name;
        if (typeof pluginName !== 'string' || pluginName.trim().length === 0) return false;
        return !pluginName.startsWith('.') || confinedFile(directory, pluginName);
      });

    return legacyLaunchable || pluginLaunchable
      ? { slug, name, directory, manifest }
      : null;
  } catch {
    return null;
  }
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
    const template = resolveLaunchableGameTemplate(engineTemplatesRoot, entry.name);
    if (template) templates.push({ slug: template.slug, name: template.name });
  }
  return templates.sort((a, b) => a.slug.localeCompare(b.slug));
}
