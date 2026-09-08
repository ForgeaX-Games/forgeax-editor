#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const EDITOR_ROOT = resolve(import.meta.dir, '..');
const ENGINE_ROOT = join(EDITOR_ROOT, 'packages/engine');
const PLAY_ROOT = join(EDITOR_ROOT, 'packages/play-runtime');
const EXCLUDES = new Set(['.git', '.forgeax-harness', 'node_modules', 'target', '__tests__', 'test', 'tests', '.vite', '.forgeax', 'host-games', 'shared-assets', 'engine-assets']);
const NATIVE_PACKAGE = /^(?:esbuild|rollup|sharp|fsevents)$|^@(?:esbuild|rollup|img)\//i;
const NATIVE_FILE = /\.(?:dll|dylib|exe|node|so)(?:\.[0-9]+)*$|(?:aarch64-apple-darwin|x86_64-apple-darwin|x86_64-pc-windows-msvc)/i;
const ENGINE_WASM_PACKAGES = new Set(['@forgeax/engine-wgpu-wasm', '@forgeax/engine-fbx', '@forgeax/engine-codec']);

/** Editor-owned Vite config helpers that must travel with the packaged Engine root. */
export const PACKAGED_VITE_HELPERS = [
  {
    source: 'scripts/vite/engine-vite-preset.ts',
    importPath: '../../scripts/vite/engine-vite-preset.ts',
    output: 'engine-vite-preset.mjs',
  },
  {
    source: 'scripts/vite/ddc-root-policy.ts',
    importPath: '../../scripts/vite/ddc-root-policy.ts',
    output: 'ddc-root-policy.mjs',
  },
] as const;

type PackageJson = {
  name?: string;
  main?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

function fail(message: string): never {
  throw new Error(`[editor-desktop-engine-runtime] ${message}`);
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

export function playRuntimeDesktopDependencyNames(): readonly string[] {
  return Object.keys(readJson(join(PLAY_ROOT, 'package.json')).dependencies ?? {});
}

function copyTree(source: string, destination: string, excludePkg = false): void {
  if (!existsSync(source)) fail(`required source is missing: ${source}`);
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true,
    filter: (path) => !EXCLUDES.has(basename(path)) && (!excludePkg || basename(path) !== 'pkg'),
  });
}

export function normalizePortableFileModes(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) normalizePortableFileModes(path);
    else if (entry.isFile()) chmodSync(path, 0o644);
  }
}

function run(args: string[], cwd = EDITOR_ROOT): void {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) fail(`command failed (${result.status}): bun ${args.join(' ')}`);
}

function indexWorkspaces(): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (directory: string, depth: number): void => {
    if (depth > 8 || !existsSync(directory)) return;
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const name = readJson(manifest).name;
      if (name && (!result.has(name) || relative(EDITOR_ROOT, directory).split(/[\\/]/).length < relative(EDITOR_ROOT, result.get(name)!).split(/[\\/]/).length)) result.set(name, directory);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || EXCLUDES.has(entry.name) || entry.name === 'src' || entry.name === 'dist' || entry.name === 'pkg') continue;
      walk(join(directory, entry.name), depth + 1);
    }
  };
  walk(join(EDITOR_ROOT, 'packages'), 0);
  return result;
}

function resolveDependency(parent: string, name: string, fallbacks: readonly string[], version?: string): string | null {
  const candidates = [join(parent, 'node_modules', name)];
  for (let ancestor = dirname(parent); ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    if (basename(ancestor) === 'node_modules') candidates.push(join(ancestor, name));
    if (ancestor === EDITOR_ROOT) break;
  }
  candidates.push(...fallbacks.map((root) => join(root, name)));
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (existsSync(join(resolved, 'package.json')) && (!version || readJson(join(resolved, 'package.json')).version === version)) return resolved;
    } catch {
      // Continue through the declared install roots.
    }
  }
  const store = join(EDITOR_ROOT, 'node_modules/.bun');
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      const candidate = join(store, entry, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json')) && (!version || readJson(join(candidate, 'package.json')).version === version)) return candidate;
    }
  }
  return null;
}

export function isTargetNativePackage(name: string, source: string): boolean {
  if (NATIVE_PACKAGE.test(name)) return true;
  const walk = (directory: string, prefix: string): boolean => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDES.has(entry.name) || entry.name === 'node_modules') continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (NATIVE_FILE.test(path)) return true;
      if (entry.isDirectory() && walk(join(directory, entry.name), path)) return true;
    }
    return false;
  };
  return walk(source, '');
}

function buildWorkspaceRuntime(source: string, manifest: PackageJson): void {
  const main = manifest.main;
  if (!main?.startsWith('./dist/')) return;
  const output = join(source, main);
  if (existsSync(output)) return;
  if (!manifest.scripts?.build) fail(`runtime workspace has no build command: ${manifest.name ?? source}`);
  run(['run', 'build'], source);
  if (!existsSync(output)) fail(`runtime workspace build did not create ${main}: ${manifest.name ?? source}`);
}

function stageDependencyClosure(output: string, scope: 'common' | 'target'): void {
  const destination = join(output, 'engine/node_modules');
  const workspaces = indexWorkspaces();
  const fallbackRoots = [join(PLAY_ROOT, 'node_modules'), join(EDITOR_ROOT, 'node_modules'), join(ENGINE_ROOT, 'node_modules')];
  const play = readJson(join(PLAY_ROOT, 'package.json'));
  const visiting = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string, parent: string, required: boolean): void => {
    if (seen.has(name)) return;
    const source = workspaces.get(name) ?? resolveDependency(parent, name, fallbackRoots);
    if (!source) {
      if (required) fail(`runtime dependency is not installed: ${name} (from ${parent})`);
      return;
    }
    if (visiting.has(name)) return;
    visiting.add(name);
    const manifest = readJson(join(source, 'package.json'));
    for (const child of Object.keys(manifest.dependencies ?? {})) visit(child, source, true);
    for (const child of Object.keys(manifest.optionalDependencies ?? {})) visit(child, source, false);
    for (const child of Object.keys(manifest.peerDependencies ?? {})) if (workspaces.has(child)) visit(child, source, true);
    for (const child of Object.keys(manifest.devDependencies ?? {})) if (workspaces.has(child)) visit(child, source, true);
    const native = isTargetNativePackage(name, source);
    if ((scope === 'target') === native) {
      if (!native && workspaces.get(name) === source) buildWorkspaceRuntime(source, manifest);
      const target = join(destination, name);
      mkdirSync(dirname(target), { recursive: true });
      copyTree(source, target, !native && ENGINE_WASM_PACKAGES.has(name));
    }
    visiting.delete(name);
    seen.add(name);
  };
  visit('vite', PLAY_ROOT, true);
  visit('typescript', PLAY_ROOT, true);
  for (const name of Object.keys(play.dependencies ?? {})) visit(name, PLAY_ROOT, true);
  if (!existsSync(destination) || readdirSync(destination).length === 0) fail(`${scope} dependency closure is empty`);
}

export function rewritePackagedViteConfig(source: string): string {
  const sourceFile = ts.createSourceFile('vite.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const moduleSpecifiers: Array<{ start: number; end: number; value: string }> = [];
  const visit = (node: ts.Node): void => {
    const moduleSpecifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
      ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1
        ? node.arguments[0]
        : undefined;
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      moduleSpecifiers.push({
        start: moduleSpecifier.getStart(sourceFile) + 1,
        end: moduleSpecifier.getEnd() - 1,
        value: moduleSpecifier.text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const replacements = moduleSpecifiers.flatMap(({ start, end, value }) => {
    const helper = PACKAGED_VITE_HELPERS.find((candidate) => candidate.importPath === value);
    return helper ? [{ start, end, value: `./${helper.output}` }] : [];
  });
  let rewritten = source;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
  }
  const unresolved = new Bun.Transpiler({ loader: 'ts' })
    .scanImports(rewritten)
    .find(({ path }) => path.startsWith('../../scripts/vite/') && path.endsWith('.ts'));
  if (unresolved) fail(`packaged Vite config retains an Editor-private helper import: ${unresolved.path}`);
  return rewritten
    .replace(/from\s+['"]\.\.\/core\/src\/asset-roots\.ts['"]/g, "from '@forgeax/editor-core/asset-roots'")
    .replace("resolve(here, '..', '..', 'forgeax-editor-assets')", "resolve(here, 'forgeax-editor-assets')")
    .replace("resolve(here, '..', 'engine', 'forgeax-engine-assets')", "resolve(here, 'forgeax-engine-assets')")
    .replace("here,\n  '..',\n  'engine',\n  'forgeax-engine-assets',", "here,\n  'forgeax-engine-assets',");
}

export function stageEditorDesktopEngineRuntime(output: string, scope: 'common' | 'target'): void {
  const destination = resolve(output);
  if (existsSync(destination)) fail(`output already exists: ${destination}`);
  mkdirSync(destination, { recursive: true });
  if (scope === 'common') {
    const engine = join(destination, 'engine');
    mkdirSync(engine, { recursive: true });
    for (const helper of PACKAGED_VITE_HELPERS) {
      run(['build', join(EDITOR_ROOT, helper.source), '--target=node', '--packages=external', '--outfile', join(engine, helper.output)]);
    }
    for (const file of ['index.html', 'package.json', 'tsconfig.json', 'rhi-debug-config.ts']) {
      const source = join(PLAY_ROOT, file);
      if (existsSync(source)) cpSync(source, join(engine, file), { force: false, errorOnExist: true });
    }
    writeFileSync(join(engine, 'vite.config.ts'), rewritePackagedViteConfig(readFileSync(join(PLAY_ROOT, 'vite.config.ts'), 'utf8')));
    copyTree(join(PLAY_ROOT, 'src'), join(engine, 'src'));
    if (existsSync(join(PLAY_ROOT, 'public'))) copyTree(join(PLAY_ROOT, 'public'), join(engine, 'public'));
    copyTree(join(EDITOR_ROOT, 'forgeax-editor-assets'), join(engine, 'forgeax-editor-assets'));
    const catalog = join(destination, 'editor/apps/standalone/template-catalog.ts');
    mkdirSync(dirname(catalog), { recursive: true });
    cpSync(join(EDITOR_ROOT, 'apps/standalone/template-catalog.ts'), catalog, { force: false, errorOnExist: true });
  }
  stageDependencyClosure(destination, scope);
  if (scope === 'common') normalizePortableFileModes(destination);
}

if (import.meta.main) {
  const output = argument('--output');
  const scope = argument('--scope');
  if (!output) fail('--output is required');
  if (scope !== 'common' && scope !== 'target') fail('--scope must be common or target');
  stageEditorDesktopEngineRuntime(output, scope);
  console.log(JSON.stringify({ code: 'EDITOR_DESKTOP_ENGINE_RUNTIME_STAGED', scope, output: resolve(output) }));
}
