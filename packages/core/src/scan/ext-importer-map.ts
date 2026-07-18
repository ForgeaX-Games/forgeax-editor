// scan/ext-importer-map.ts — extension → importer key mapping (G2).
//
// This is a local copy of the canonical import format registry from
// content-browser/src/import-registry.ts, kept in core to avoid a reverse
// dependency (core → content-browser is allowed architecturally, but when
// content-browser also imports from core, inline copy is safer).
//
// The SSOT for import formats remains in content-browser's import-registry.ts.
// Keep this mapping in sync when new formats are added.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G2

export type ImporterKey = 'image' | 'gltf' | 'fbx' | 'audio' | 'font' | 'pack';

export type SubAssetKind =
  | 'mesh' | 'material' | 'scene' | 'texture' | 'image'
  | 'cube-texture' | 'material-shader' | 'skeleton' | 'skin'
  | 'animation-clip' | 'audio' | 'font' | 'sampler';

export interface ImportFormat {
  extensions: string[];
  label: string;
  importer: ImporterKey;
  /**
   * Sub-asset kinds declared in the sidecar .meta.json.  Most importers produce
   * a single sub-asset; font produces three (texture atlas, sampler, font glyph
   * metrics) so the fontImporter can resolve each by kind.
   */
  subAssetKinds: SubAssetKind[];
  defaultSettings: Record<string, unknown>;
}

/** Canonical extension → importer format mapping. Keep in sync with content-browser/src/import-registry.ts. */
export const IMPORT_FORMATS: ImportFormat[] = [
  {
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
    label: 'Image Texture',
    importer: 'image',
    subAssetKinds: ['texture'],
    defaultSettings: { colorSpace: 'srgb', mipmap: 'auto', addressMode: 'repeat', filterMode: 'linear' },
  },
  {
    extensions: ['.hdr'],
    label: 'HDR Environment',
    importer: 'image',
    subAssetKinds: ['cube-texture'],
    defaultSettings: { colorSpace: 'linear', mipmap: 'none', addressMode: 'clamp-to-edge', filterMode: 'linear', kind: 'cube-texture' },
  },
  {
    extensions: ['.glb', '.gltf'],
    label: '3D Model (GLB/glTF)',
    importer: 'gltf',
    subAssetKinds: ['scene'],
    defaultSettings: { scale: 1.0, generateTangents: true },
  },
  {
    extensions: ['.fbx'],
    label: '3D Model (FBX)',
    importer: 'fbx',
    subAssetKinds: ['scene'],
    defaultSettings: { scale: 1.0, generateTangents: true },
  },
  {
    extensions: ['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.opus'],
    label: 'Audio',
    importer: 'audio',
    subAssetKinds: ['audio'],
    defaultSettings: {},
  },
  {
    extensions: ['.ttf', '.otf', '.woff2'],
    label: 'Font',
    importer: 'font',
    subAssetKinds: ['texture', 'sampler', 'font'],
    defaultSettings: {},
  },
];

const extMap = new Map<string, ImportFormat>();
for (const fmt of IMPORT_FORMATS) {
  for (const ext of fmt.extensions) extMap.set(ext, fmt);
}

/** Look up the import format for a file extension (e.g. '.glb'). */
export function getImportFormat(ext: string): ImportFormat | undefined {
  return extMap.get(ext.toLowerCase());
}

/** Check if a filename has a recognized importable extension. */
export function isImportable(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return false;
  return extMap.has(filename.slice(dot).toLowerCase());
}

/** All supported extensions (flat list). */
export function getAllExtensions(): string[] {
  return IMPORT_FORMATS.flatMap(f => f.extensions);
}
