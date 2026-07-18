/**
 * Import format registry — maps file extensions to engine importer keys
 * and default import settings (aligned with meta.schema.json).
 */

export type ImporterKey = 'image' | 'gltf' | 'fbx' | 'audio' | 'font' | 'pack';

/** Sub-asset kind enum from meta.schema.json subAsset.kind. */
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
    defaultSettings: {},
  },
  {
    extensions: ['.fbx'],
    label: '3D Model (FBX)',
    importer: 'fbx',
    subAssetKinds: ['scene'],
    defaultSettings: {},
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

/** Look up the import format for a file extension (e.g. '.png'). */
export function getImportFormat(ext: string): ImportFormat | undefined {
  return extMap.get(ext.toLowerCase());
}

/** Build a combined `accept` attribute string for file input elements. */
export function buildAcceptString(): string {
  return IMPORT_FORMATS.flatMap(f => f.extensions).join(',');
}

/** Diagnostic snapshot — kept exported for HMR/stale-chunk compatibility. */
export function getImportRegistrySnapshot() {
  const extensions = IMPORT_FORMATS.flatMap(f => f.extensions);
  const accept = buildAcceptString();
  return {
    moduleUrl: import.meta.url,
    formatCount: IMPORT_FORMATS.length,
    importers: IMPORT_FORMATS.map(f => f.importer),
    extensions,
    accept,
    hasFbx: extensions.includes('.fbx'),
  };
}

/** Check if a filename has a recognized importable extension. */
export function isImportable(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return false;
  return extMap.has(filename.slice(dot).toLowerCase());
}

/** Dev tracing — filter console: CB:import */
export function logImport(step: string, data?: Record<string, unknown>): void {
  const href = typeof location !== 'undefined' ? location.href : undefined;
  console.info('[CB:import]', step, { ...data, href });
}
