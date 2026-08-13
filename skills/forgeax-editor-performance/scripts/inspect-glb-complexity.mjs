#!/usr/bin/env node

// Read-only GLB topology inventory. It parses only the JSON chunk and reports
// primitive/index/vertex counts; no GPU, editor, or asset import is required.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

function parseCli(argv) {
  const flags = { roots: [], out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') flags.roots.push(resolve(argv[++index]));
    else if (arg === '--out') flags.out = resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun inspect-glb-complexity.mjs --root DIR [--root DIR...] [--out FILE]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (flags.roots.length === 0) throw new Error('at least one --root DIR is required');
  return flags;
}

async function collectGlbs(root) {
  const files = [];
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.glb') files.push(path);
    }
  };
  await visit(root);
  return files;
}

function readGlbJson(bytes, path) {
  if (bytes.byteLength < 20 || bytes.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error(`${path}: invalid GLB header`);
  }
  const declaredLength = bytes.readUInt32LE(8);
  if (declaredLength > bytes.byteLength) throw new Error(`${path}: truncated GLB`);
  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const chunkLength = bytes.readUInt32LE(offset);
    const chunkType = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + chunkLength > declaredLength) throw new Error(`${path}: truncated GLB chunk`);
    if (chunkType === 0x4e4f534a) {
      return JSON.parse(bytes.toString('utf8', offset, offset + chunkLength).replace(/\0+$/u, ''));
    }
    offset += chunkLength;
  }
  throw new Error(`${path}: JSON chunk not found`);
}

function inspectGlb(root, path, bytes) {
  const gltf = readGlbJson(bytes, path);
  const accessors = gltf.accessors ?? [];
  let primitives = 0;
  let indices = 0;
  let vertices = 0;
  let indexedPrimitives = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      primitives += 1;
      const positionAccessor = primitive.attributes?.POSITION;
      const vertexCount = accessors[positionAccessor]?.count ?? 0;
      vertices += vertexCount;
      if (primitive.indices === undefined) {
        indices += vertexCount;
      } else {
        indexedPrimitives += 1;
        indices += accessors[primitive.indices]?.count ?? 0;
      }
    }
  }
  return {
    path: relative(root, path),
    bytes: bytes.byteLength,
    nodes: gltf.nodes?.length ?? 0,
    meshes: gltf.meshes?.length ?? 0,
    primitives,
    indexedPrimitives,
    vertices,
    indices,
    triangles: Math.floor(indices / 3),
    materials: gltf.materials?.length ?? 0,
    textures: gltf.textures?.length ?? 0,
  };
}

async function main() {
  const flags = parseCli(process.argv.slice(2));
  const assets = [];
  for (const root of flags.roots) {
    for (const path of await collectGlbs(root)) {
      assets.push({ root, ...(inspectGlb(root, path, await readFile(path))) });
    }
  }
  assets.sort((a, b) => b.indices - a.indices || b.primitives - a.primitives);
  const report = {
    schemaVersion: 1,
    roots: flags.roots,
    totals: {
      files: assets.length,
      bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
      meshes: assets.reduce((sum, asset) => sum + asset.meshes, 0),
      primitives: assets.reduce((sum, asset) => sum + asset.primitives, 0),
      vertices: assets.reduce((sum, asset) => sum + asset.vertices, 0),
      indices: assets.reduce((sum, asset) => sum + asset.indices, 0),
    },
    assets,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (flags.out === undefined) process.stdout.write(text);
  else await writeFile(flags.out, text);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
