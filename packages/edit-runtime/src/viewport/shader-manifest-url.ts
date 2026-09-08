import type { ManifestEntry } from '@forgeax/engine-types';

type MaterialShaderManifestEntry = {
  readonly identifier: string;
  readonly sourcePath: string;
  readonly composedWgsl: string;
  readonly paramSchema: string;
  readonly variants: readonly unknown[];
  readonly uvSetCount?: number;
};

export type ViewportShaderManifestDocument = {
  readonly schemaVersion?: number;
  readonly entries: ManifestEntry[];
  readonly materialShaders?: readonly MaterialShaderManifestEntry[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseManifestDocument(raw: string, url: string): ViewportShaderManifestDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `shader manifest at ${url} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    throw new Error(`shader manifest at ${url} is missing required entries[]`);
  }
  return parsed as ViewportShaderManifestDocument;
}

async function fetchShaderManifest(url: string): Promise<ViewportShaderManifestDocument> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `shader manifest fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`shader manifest fetch failed for ${url}: HTTP ${response.status} ${raw.slice(0, 120)}`);
  }
  return parseManifestDocument(raw, url);
}

/**
 * Merge Play (engine SSOT) with the IDE host manifest (editor-authored shaders).
 * Play entries win hash collisions; host material shaders only fill gaps.
 */
export function mergeViewportShaderManifests(
  playManifest: ViewportShaderManifestDocument,
  hostManifest: ViewportShaderManifestDocument,
): ViewportShaderManifestDocument {
  const entriesByHash = new Map<string, ManifestEntry>();
  for (const entry of playManifest.entries) entriesByHash.set(entry.hash, entry);
  for (const entry of hostManifest.entries) {
    if (!entriesByHash.has(entry.hash)) entriesByHash.set(entry.hash, entry);
  }

  const materialShadersById = new Map<string, MaterialShaderManifestEntry>();
  for (const entry of playManifest.materialShaders ?? []) {
    materialShadersById.set(entry.identifier, entry);
  }
  for (const entry of hostManifest.materialShaders ?? []) {
    if (!materialShadersById.has(entry.identifier)) {
      materialShadersById.set(entry.identifier, entry);
    }
  }

  return {
    schemaVersion: playManifest.schemaVersion ?? hostManifest.schemaVersion,
    entries: [...entriesByHash.values()],
    materialShaders: [...materialShadersById.values()],
  };
}

/**
 * Studio release runs the viewport inside the IDE shell (base `/`) while Play
 * owns engine shaders under `/preview/`. Standalone edit-runtime serves both
 * from one forgeaxShader instance at `/editor/shaders/manifest.json`.
 */
export function needsViewportShaderManifestMerge(
  baseUrl: string,
  _hasRuntimeBinding: boolean,
  _gameDirAbs: string | null | undefined,
): boolean {
  const base = baseUrl.replace(/\/$/, '');
  // Standalone edit-runtime (including Studio iframe at `/editor/`) serves a
  // complete manifest from one forgeaxShader instance.
  return !base.endsWith('/editor');
}

function hostShaderManifestUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/shaders/manifest.json`;
}

function playShaderManifestUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/preview/shaders/manifest.json`;
}

/**
 * Resolve the shader manifest for the viewport's carrier.
 *
 * Editor-authored viewport features are compiled by the IDE host and served
 * beside `/editor/`, including when game assets come from a late-bound Runtime.
 *
 * SSOT: main #846. Studio carriers that split engine vs editor manifests must
 * call `prepareViewportShaderManifestUrl` before `createApp`.
 */
export function resolveViewportShaderManifestUrl(
  baseUrl: string,
  _hasRuntimeBinding: boolean,
  _gameDirAbs: string | null | undefined,
): string {
  return hostShaderManifestUrl(baseUrl);
}

/**
 * Resolve a manifest URL that is safe to pass to `createApp`.
 *
 * Standalone edit-runtime keeps the #846 host URL. Studio IDE shell carriers
 * merge Play + host manifests so engine entries and `editor::infinite-grid`
 * coexist without forking the long-term host manifest contract.
 */
export async function prepareViewportShaderManifestUrl(
  baseUrl: string,
  hasRuntimeBinding: boolean,
  gameDirAbs: string | null | undefined,
): Promise<string> {
  const hostUrl = resolveViewportShaderManifestUrl(baseUrl, hasRuntimeBinding, gameDirAbs);
  if (!needsViewportShaderManifestMerge(baseUrl, hasRuntimeBinding, gameDirAbs)) {
    return hostUrl;
  }
  const [playManifest, hostManifest] = await Promise.all([
    fetchShaderManifest(playShaderManifestUrl(baseUrl)),
    fetchShaderManifest(hostUrl),
  ]);
  const merged = mergeViewportShaderManifests(playManifest, hostManifest);
  return URL.createObjectURL(new Blob([JSON.stringify(merged)], { type: 'application/json' }));
}
