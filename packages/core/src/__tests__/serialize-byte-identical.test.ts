// serialize-byte-identical.test.ts — golden gate for engine serializeMetaJson
// byte-stable output (AC-05). Hand-crafted sample meta objects for gltf + fbx
// shapes with boundary#2 sensitive inputs (nested key乱序, arrays, unicode,
// number formatting). Tags: AC-05, plan-strategy D-5, research F-7.
//
// Golden source: engine's serializeMetaJson (SSOT in serialize-meta.ts).
// The test asserts byte-identical output — not semantic equivalence — because
// consumers (studio pack, engine sync) depend on byte-identical diff-free
// serialization for the `<source>.meta.json` sidecar.

import { describe, expect, it } from 'bun:test';
import { serializeMetaJson } from '@forgeax/engine-gltf';

// --- helpers ---

/** Literal \n + trailing newline → normalized string for inline expectations. */
function nl(lines: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    out += lines[i]!;
    if (i < values.length) out += String(values[i]!);
  }
  return `${out}\n`;
}

// --- gltf shape (external-asset-package + importer: 'gltf') ---

const gltfSample = {
  // Keys deliberately out of order — sortKeysDeep must sort them.
  subAssets: [] as readonly unknown[],
  source: 'character.glb',
  schemaVersion: 1 as const,
  kind: 'external-asset-package' as const,
  importer: 'gltf' as const,
  importSettings: {
    diagnostics: {
      unsupportedExtensions: [] as readonly string[],
      nodeNames: [] as readonly string[],
      matrixTrsCoexistNodes: [] as readonly number[],
    },
    defaultSceneIndex: 0,
  },
};

const gltfExpected = nl`{
  "importSettings": {
    "defaultSceneIndex": 0,
    "diagnostics": {
      "matrixTrsCoexistNodes": [],
      "nodeNames": [],
      "unsupportedExtensions": []
    }
  },
  "importer": "gltf",
  "kind": "external-asset-package",
  "schemaVersion": 1,
  "source": "character.glb",
  "subAssets": []
}`;

// --- fbx shape (importer: 'fbx') ---

const fbxSample = {
  // Keys deliberately out of order — sortKeysDeep must sort them.
  source: 'character.fbx',
  kind: 'external-asset-package' as const,
  schemaVersion: 1 as const,
  subAssets: [] as readonly unknown[],
  importer: 'fbx' as const,
  importSettings: {
    defaultSceneIndex: 0,
    diagnostics: {
      matrixTrsCoexistNodes: [] as readonly number[],
      unsupportedExtensions: [] as readonly string[],
      nodeNames: [] as readonly string[],
    },
  },
};

const fbxExpected = nl`{
  "importSettings": {
    "defaultSceneIndex": 0,
    "diagnostics": {
      "matrixTrsCoexistNodes": [],
      "nodeNames": [],
      "unsupportedExtensions": []
    }
  },
  "importer": "fbx",
  "kind": "external-asset-package",
  "schemaVersion": 1,
  "source": "character.fbx",
  "subAssets": []
}`;

// --- boundary#2: nested key乱序 ---

const nestedKeyScrambleSample = {
  c: { f: 3, e: 2, d: 1 },
  a: 1,
  b: { g: { j: 4, i: 3, h: 2 }, z: 0 },
};

const nestedKeyScrambleExpected = nl`{
  "a": 1,
  "b": {
    "g": {
      "h": 2,
      "i": 3,
      "j": 4
    },
    "z": 0
  },
  "c": {
    "d": 1,
    "e": 2,
    "f": 3
  }
}`;

// --- boundary#2: arrays ---

const arraySample = {
  tags: ['b', 'a', 'c'],
  // Array elements are NOT sorted by sortKeysDeep — only object keys are.
  items: [3, 1, 2],
  nested: { data: [9, 8, 7], name: 'x' },
};

const arrayExpected = nl`{
  "items": [
    3,
    1,
    2
  ],
  "nested": {
    "data": [
      9,
      8,
      7
    ],
    "name": "x"
  },
  "tags": [
    "b",
    "a",
    "c"
  ]
}`;

// --- boundary#2: unicode ---

const unicodeSample = {
  name: 'B\xF6hn',
  description: 'サンプル', // サンプル
  emoji: '🚀', // 🚀
};

const unicodeExpected = nl`{
  "description": "サンプル",
  "emoji": "🚀",
  "name": "B\xF6hn"
}`;

// --- boundary#2: number formatting ---

const numberSample = {
  integer: 42,
  negative: -17,
  zero: 0,
  float: 3.14159,
  bigNumber: 1e10,
  smallFloat: 1.5e-3,
  // eslint-disable-next-line @typescript-eslint/no-loss-of-precision
  precise: 0.12345678901234567,
};

const numberExpected = nl`{
  "bigNumber": 10000000000,
  "float": 3.14159,
  "integer": 42,
  "negative": -17,
  "precise": 0.12345678901234566,
  "smallFloat": 0.0015,
  "zero": 0
}`;

// --- tests ---

describe('serialize-byte-identical (AC-05 golden)', () => {
  describe('gltf shape', () => {
    it('produces byte-identical output for external-asset-package gltf meta', () => {
      const output = serializeMetaJson(gltfSample);
      expect(output).toBe(gltfExpected);
    });
  });

  describe('fbx shape', () => {
    it('produces byte-identical output for external-asset-package fbx meta', () => {
      const output = serializeMetaJson(fbxSample);
      expect(output).toBe(fbxExpected);
    });
  });

  describe('boundary#2: nested key乱序', () => {
    it('sorts all keys at every nesting level', () => {
      const output = serializeMetaJson(nestedKeyScrambleSample);
      expect(output).toBe(nestedKeyScrambleExpected);
    });
  });

  describe('boundary#2: arrays', () => {
    it('preserves array element order (does not sort arrays)', () => {
      const output = serializeMetaJson(arraySample);
      expect(output).toBe(arrayExpected);
    });
  });

  describe('boundary#2: unicode', () => {
    it('outputs unicode strings byte-identically', () => {
      const output = serializeMetaJson(unicodeSample);
      expect(output).toBe(unicodeExpected);
    });
  });

  describe('boundary#2: number formatting', () => {
    it('outputs numbers with consistent JSON formatting', () => {
      const output = serializeMetaJson(numberSample);
      expect(output).toBe(numberExpected);
    });
  });
});