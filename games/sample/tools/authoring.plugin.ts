import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { defineToolPlugin, type Plugin } from '@forgeax/engine-plugin';
import { defineTool, type JsonValue, type ToolContribution, type ToolDomainFailure, type ToolSchema } from '@forgeax/engine-tool-runtime';
import { cookParticleCodeEffect, type ParticleCodeModuleSet } from '@forgeax/engine-vfx-compiler';
import { parseParticleEffectSourceV2, type ParticleEffectSourceV2 } from '@forgeax/engine-vfx';

/**
 * This fixture is a Project-owned build plugin. The Editor only transports
 * these Engine Tool Runtime arguments; it does not ship a second authoring
 * registry or executor. A real game replaces these producers with its own
 * source/Meta and cook authorities.
 */

type RecordValue = Record<string, unknown>;
type SubjectKind = 'material' | 'mesh' | 'vfx';
type Subject = { readonly kind: SubjectKind; readonly guid: string };
type MaterialState = { readonly values: Record<string, unknown>; readonly textureGuids?: Record<string, string> };
type MaterialPatch = { readonly values?: Record<string, unknown>; readonly textureGuids?: Record<string, string> };
type MeshSlot = { readonly slotName: string; readonly sourceKey?: string; readonly defaultMaterialGuid?: string | null };
type MeshDefaults = Readonly<Record<string, string | null>>;
type MeshState = { readonly sourceKey: string; readonly materialSlots: readonly MeshSlot[]; readonly materialSlotDefaultOverrides?: MeshDefaults };
type MeshPatch = { readonly materialSlots: readonly MeshSlot[]; readonly materialSlotDefaultOverrides?: MeshDefaults | null };
type MeshSubAsset = { readonly guid?: unknown; readonly kind?: unknown; readonly sourceKey?: unknown; readonly sourceIndex?: unknown };
type MeshMeta = { readonly subAssets?: readonly MeshSubAsset[]; readonly sourceOverrides?: Readonly<Record<string, MeshState>>; readonly [key: string]: unknown };
type VfxState = ParticleEffectSourceV2;
type VfxPatch = { readonly source: ParticleEffectSourceV2 };

/**
 * A Project source identity is intentionally smaller than a runtime catalog
 * row.  It is the producer fact needed to re-read the source after a cold
 * ToolClient discovery; it never contains an Editor World or a live asset
 * handle.
 */
type SourceIdentity = {
  readonly sourcePath: string;
  readonly sourceKey?: string;
  readonly sourceIndex?: number;
  readonly importer?: string;
};

type PreviewBindingProjection = {
  readonly operationId: 'material.preview' | 'mesh.preview' | 'vfx.preview';
  readonly subject: { readonly kind: 'MaterialAsset' | 'MeshAsset' | 'ParticleEffectAsset'; readonly guid: string };
  readonly sourceRevision: string;
  readonly sourceIdentity: SourceIdentity;
  /** Runtime binding is intentionally deferred to the Engine AssetRegistry. */
  readonly status: 'requires-runtime-materialization';
};

interface Snapshot<S> {
  readonly subject: Subject;
  readonly revision: string;
  readonly state: S;
  readonly identity?: SourceIdentity;
}

interface UpdateArgs<S, P> {
  readonly subject: Subject;
  readonly snapshot: Snapshot<S>;
  readonly expectedRevision: string;
  readonly patch: P;
}

interface UpdateResult<S> {
  readonly subject: Subject;
  readonly beforeRevision: string;
  readonly afterRevision: string;
  readonly state: S;
  readonly receipts: readonly string[];
  readonly sourceIdentity: SourceIdentity;
  readonly previewBinding: PreviewBindingProjection;
}

interface SourceSnapshotResult<S> {
  readonly subject: Subject;
  readonly revision: string;
  readonly state: S;
  readonly identity: SourceIdentity;
  readonly previewBinding: PreviewBindingProjection;
}

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MATERIAL_ROOT = join(PROJECT_ROOT, 'assets', 'authoring', 'materials');
// Imported Mesh source/Meta is a Project asset, not an Editor fixture.  The
// provider scans the Project asset root and resolves the authoritative Meta
// from the catalog subject + sourceKey supplied by the caller.
const MESH_ROOT = join(PROJECT_ROOT, 'assets');
const VFX_PACK = join(PROJECT_ROOT, 'assets', 'vfx', 'particle-effects.pack.json');
const VFX_ROOT = join(PROJECT_ROOT, 'assets', 'vfx');
const VFX_COOKER = join(PROJECT_ROOT, 'tools', 'vfx-cook.mjs');
const COOK_ROOT = join(PROJECT_ROOT, '.forgeax', 'authoring');

function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function revision(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizeRevision(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function previewSubject(subject: Subject): PreviewBindingProjection['subject'] {
  if (subject.kind === 'material') return { kind: 'MaterialAsset', guid: subject.guid };
  if (subject.kind === 'mesh') return { kind: 'MeshAsset', guid: subject.guid };
  return { kind: 'ParticleEffectAsset', guid: subject.guid };
}

function previewBinding(subject: Subject, sourceRevision: string, sourceIdentity: SourceIdentity): PreviewBindingProjection {
  return {
    operationId: `${subject.kind}.preview` as PreviewBindingProjection['operationId'],
    subject: previewSubject(subject),
    sourceRevision,
    sourceIdentity: { ...sourceIdentity },
    status: 'requires-runtime-materialization',
  };
}

function makeSourceSnapshot<S>(input: {
  readonly subject: Subject;
  readonly revision: string;
  readonly state: S;
  readonly identity: SourceIdentity;
}): SourceSnapshotResult<S> {
  return {
    subject: input.subject,
    revision: input.revision,
    state: input.state,
    identity: input.identity,
    previewBinding: previewBinding(input.subject, input.revision, input.identity),
  };
}

function schema<T>(description: string, kind: SubjectKind): ToolSchema<T> {
  return {
    describe: description,
    parse(value) {
      if (!record(value) || !record(value.subject) || value.subject.kind !== kind || typeof value.subject.guid !== 'string') {
        return { ok: false, error: `expected a ${kind} subject with a GUID` };
      }
      if (!record(value.snapshot)
        || !record(value.snapshot.subject)
        || value.snapshot.subject.kind !== kind
        || value.snapshot.subject.guid !== value.subject.guid
        || typeof value.snapshot.revision !== 'string'
        || !('state' in value.snapshot)) {
        return { ok: false, error: 'expected snapshot.subject, snapshot.revision, and snapshot.state' };
      }
      if (typeof value.expectedRevision !== 'string' || !('patch' in value)) {
        return { ok: false, error: 'expected expectedRevision and domain patch' };
      }
      return { ok: true, value: value as unknown as T };
    },
  };
}

function resultSchema<S>(): ToolSchema<UpdateResult<S>> {
  return {
    describe: '{ subject: object, beforeRevision: string, afterRevision: string, state: object, receipts: string[], sourceIdentity: object, previewBinding: object }',
    parse(value) { return { ok: true, value: value as UpdateResult<S> }; },
  };
}

const sourceSnapshotSchema: ToolSchema<{ readonly subject: Subject }> = {
  describe: '{ subject: { kind: "material" | "mesh" | "vfx", guid: string } }',
  parse(value) {
    if (!record(value) || !record(value.subject)
      || !['material', 'mesh', 'vfx'].includes(value.subject.kind as string)
      || typeof value.subject.guid !== 'string'
      || value.subject.guid.trim() === '') {
      return { ok: false, error: 'expected a Project subject with kind material, mesh, or vfx and a GUID' };
    }
    return { ok: true, value: { subject: value.subject as Subject } };
  },
};

const sourceSnapshotResultSchema: ToolSchema<SourceSnapshotResult<unknown>> = {
  describe: '{ subject: object, revision: string, state: object, identity: object, previewBinding: object }',
  parse(value) { return { ok: true, value: value as SourceSnapshotResult<unknown> }; },
};

function domainFailure(error: { readonly code: string; readonly expected: string; readonly hint: string; readonly current?: string; readonly draft?: unknown }): { ok: false; error: ToolDomainFailure } {
  return {
    ok: false,
    error: {
      code: error.code,
      expected: error.expected,
      hint: error.hint,
      detail: {
        ...(error.current === undefined ? {} : { current: error.current }),
        ...(error.draft === undefined ? {} : { draft: error.draft as JsonValue }),
        retryable: error.code.endsWith('revision-conflict'),
        recoveryActions: error.code.endsWith('revision-conflict')
          ? ['authoring.refresh', 'authoring.retry']
          : ['tool.describe'],
      } as JsonValue,
    },
  };
}

async function text(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch { return undefined; }
}

async function atomic(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, bytes, 'utf8');
  await rename(temporary, path);
}

async function atomicBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === '.git' || entry.name === '.forgeax' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  await visit(root);
  return result;
}

async function findMeshMeta(subjectGuid: string, sourceKey: string): Promise<{ readonly path: string } | undefined> {
  for (const path of await files(MESH_ROOT)) {
    if (!path.endsWith('.meta.json')) continue;
    const bytes = await text(path);
    if (bytes === undefined) continue;
    try {
      const meta = JSON.parse(bytes) as MeshMeta;
      const match = meta.subAssets?.some((entry) => (
        entry.guid === subjectGuid && entry.kind === 'mesh' && entry.sourceKey === sourceKey
      ));
      if (match) return { path };
    } catch {
      // An unrelated or half-written Meta does not hide another candidate.
    }
  }
  return undefined;
}

async function findMeshSource(subjectGuid: string): Promise<{
  readonly path: string;
  readonly meta: MeshMeta;
  readonly sourceKey: string;
  readonly sourceIndex?: number;
  readonly state: MeshState;
} | undefined> {
  for (const path of await files(MESH_ROOT)) {
    if (!path.endsWith('.meta.json')) continue;
    const bytes = await text(path);
    if (bytes === undefined) continue;
    try {
      const meta = JSON.parse(bytes) as MeshMeta;
      const entry = meta.subAssets?.find((candidate) => (
        candidate.guid === subjectGuid
        && candidate.kind === 'mesh'
        && typeof candidate.sourceKey === 'string'
      ));
      if (entry === undefined || typeof entry.sourceKey !== 'string') continue;
      const state = meta.sourceOverrides?.[entry.sourceKey];
      if (state === undefined) continue;
      return {
        path,
        meta,
        sourceKey: entry.sourceKey,
        ...(typeof entry.sourceIndex === 'number' ? { sourceIndex: entry.sourceIndex } : {}),
        state,
      };
    } catch {
      // An unrelated or half-written Meta does not hide another candidate.
    }
  }
  return undefined;
}

async function jsonUpdate<S extends object, P>(input: {
  readonly path: string;
  readonly subject: Subject;
  readonly expectedRevision: string;
  readonly patch: P;
  readonly merge: (current: S, patch: P) => S | { readonly error: ReturnType<typeof domainFailure> };
  readonly sourceIdentity: SourceIdentity;
  readonly publish?: (next: S, nextRevision: string) => Promise<readonly string[]>;
}): Promise<{ readonly ok: true; readonly value: UpdateResult<S> } | ReturnType<typeof domainFailure>> {
  const before = await text(input.path);
  if (before === undefined) return domainFailure({ code: 'authoring-subject-missing', expected: 'an existing Project source', hint: `Project subject ${input.subject.guid} is unavailable.` });
  const beforeRevision = revision(before);
  let current: S;
  try { current = JSON.parse(before) as S; } catch {
    return domainFailure({ code: 'authoring-source-invalid', expected: 'valid JSON Project source', hint: `Project subject ${input.subject.guid} is invalid.` });
  }
  const expectedRevision = normalizeRevision(input.expectedRevision);
  if (beforeRevision !== expectedRevision) {
    return domainFailure({
      code: 'authoring-revision-conflict',
      expected: expectedRevision,
      current: beforeRevision,
      draft: current,
      hint: 'Project source changed after the supplied snapshot; refresh before retrying.',
    });
  }
  const merged = input.merge(current, input.patch);
  if ('error' in merged) return merged.error;
  const bytes = `${JSON.stringify(merged as unknown, null, 2)}\n`;
  const nextRevision = revision(bytes);
  await atomic(input.path, bytes);
  // The Project source/Meta is the authority. Derived cook output is published
  // only after the source commit; a failed cache publication must not make a
  // stale cache look newer than the authored file.
  let receipts: readonly string[] = [];
  if (input.publish !== undefined) {
    try {
      receipts = await input.publish(merged, nextRevision);
    } catch (cause) {
      // A derived receipt is disposable.  If it cannot be published, restore
      // the source so a failed ToolClient run never leaves a half-committed
      // authored fact behind.
      await atomic(input.path, before).catch(() => undefined);
      return domainFailure({
        code: 'authoring-publication-failed',
        expected: 'the derived receipt to publish after the source commit',
        hint: cause instanceof Error ? cause.message : 'Derived publication failed; retry from the source snapshot.',
      });
    }
  }
  return {
    ok: true,
    value: {
      subject: input.subject,
      beforeRevision,
      afterRevision: nextRevision,
      state: merged,
      receipts,
      sourceIdentity: input.sourceIdentity,
      previewBinding: previewBinding(input.subject, nextRevision, input.sourceIdentity),
    },
  };
}

const material = defineTool<UpdateArgs<MaterialState, MaterialPatch>, UpdateResult<MaterialState>>(
  {
    id: 'material.author.update',
    title: 'Update material source',
    summary: 'Atomically updates a Project material source through its producer.',
    realm: 'build',
    argsSchema: schema('{ subject: { kind: \'material\', guid: string }, snapshot: { revision: string, state: object }, expectedRevision: string, patch: object }', 'material'),
    resultSchema: resultSchema<MaterialState>(),
    evidence: [],
  },
  async ({ subject, expectedRevision, patch }) => {
    const result = await jsonUpdate<MaterialState, MaterialPatch>({
      path: join(MATERIAL_ROOT, `${subject.guid}.json`),
      subject,
      expectedRevision,
      patch,
      sourceIdentity: { sourcePath: relative(PROJECT_ROOT, join(MATERIAL_ROOT, `${subject.guid}.json`)).replace(/\\/g, '/') },
      merge: (current, next) => ({
        values: { ...current.values, ...(next.values ?? {}) },
        ...(next.textureGuids === undefined ? (current.textureGuids === undefined ? {} : { textureGuids: current.textureGuids }) : { textureGuids: { ...(current.textureGuids ?? {}), ...next.textureGuids } }),
      }),
    });
    return result.ok ? result.value : result;
  },
);

const mesh = defineTool<UpdateArgs<MeshState, MeshPatch>, UpdateResult<MeshMeta>>(
  {
    id: 'mesh.author.update',
    title: 'Update mesh source metadata',
    summary: 'CAS-updates Mesh material-slot defaults and publishes a recook receipt.',
    realm: 'build',
    argsSchema: schema('{ subject: { kind: \'mesh\', guid: string }, snapshot: { revision: string, state: object }, expectedRevision: string, patch: object }', 'mesh'),
    resultSchema: resultSchema<MeshMeta>(),
    evidence: [],
  },
  async ({ subject, snapshot, expectedRevision, patch }) => {
    const sourceKey = snapshot.state.sourceKey;
    if (typeof sourceKey !== 'string' || sourceKey.trim() === '') {
      return domainFailure({
        code: 'mesh-catalog-identity-missing',
        expected: 'snapshot.state.sourceKey from the live Engine catalog',
        hint: 'The Mesh snapshot has no producer source identity; refresh the Runtime catalog before retrying.',
      });
    }
    const located = await findMeshMeta(subject.guid, sourceKey);
    if (located === undefined) {
      return domainFailure({
        code: 'mesh-source-missing',
        expected: `a Project Mesh Meta containing ${subject.guid} at ${sourceKey}`,
        hint: 'The Project Mesh source is unavailable; refresh the Runtime catalog before retrying.',
      });
    }
    const result = await jsonUpdate<MeshMeta, MeshPatch>({
      path: located.path,
      subject,
      expectedRevision,
      patch,
      sourceIdentity: {
        sourcePath: relative(PROJECT_ROOT, located.path).replace(/\\/g, '/'),
        sourceKey,
      },
      merge: (current, next) => {
        const previous = current.sourceOverrides?.[sourceKey];
        if (previous === undefined) return { error: domainFailure({ code: 'mesh-source-missing', expected: `sourceOverrides.${sourceKey}`, hint: 'Mesh source metadata has no producer-owned source override.' }) };
        if (next.materialSlots.length !== previous.materialSlots.length || next.materialSlots.some((slot, index) => slot.slotName !== previous.materialSlots[index]?.slotName)) {
          return { error: domainFailure({ code: 'mesh-source-topology-immutable', expected: 'the existing Mesh slot identities', hint: 'Mesh topology is producer-owned; only material defaults may change.' }) };
        }
        const merged: RecordValue = { ...previous, materialSlots: next.materialSlots };
        if (next.materialSlotDefaultOverrides === null) delete merged.materialSlotDefaultOverrides;
        else if (next.materialSlotDefaultOverrides !== undefined) merged.materialSlotDefaultOverrides = next.materialSlotDefaultOverrides;
        return {
          ...current,
          sourceOverrides: { ...(current.sourceOverrides ?? {}), [sourceKey]: merged as MeshState },
        };
      },
      publish: async (next, nextRevision) => {
        const path = join(COOK_ROOT, 'mesh', `${subject.guid}.cook.json`);
        const published = next.sourceOverrides?.[sourceKey];
        await atomic(path, `${JSON.stringify({ sourceKey, materialSlots: published?.materialSlots ?? [], sourceRevision: nextRevision }, null, 2)}\n`);
        return [relative(PROJECT_ROOT, path).replace(/\\/g, '/')];
      },
    });
    return result.ok ? result.value : result;
  },
);

async function vfxCurrent(subjectGuid: string): Promise<{ readonly bytes: string; readonly root: RecordValue; readonly index: number; readonly state: VfxState } | undefined> {
  const bytes = await text(VFX_PACK);
  if (bytes === undefined) return undefined;
  try {
    const root = JSON.parse(bytes) as unknown;
    if (!record(root) || !Array.isArray(root.assets)) return undefined;
    const index = root.assets.findIndex((asset) => record(asset)
      && asset.kind === 'particle-effect'
      && asset.guid === subjectGuid
      && record(asset.payload));
    const asset = index < 0 ? undefined : root.assets[index];
    if (!record(asset)) return undefined;
    const parsed = parseParticleEffectSourceV2(asset.payload);
    return parsed.ok ? { bytes, root, index, state: parsed.value } : undefined;
  } catch { return undefined; }
}

/**
 * Cold source read for UI, CLI, and other ToolClient callers.  The caller only
 * supplies a Project subject; source bytes, revision, and producer identity
 * are resolved here from the same files used by the authority-write tools.
 * The preview projection deliberately stops before runtime materialization:
 * it carries identity and revision, never a fabricated GPU binding/artifact.
 */
const readSourceSnapshotTool = defineTool<{ readonly subject: Subject }, SourceSnapshotResult<unknown>>(
  {
    id: 'authoring.snapshot.read',
    title: 'Read Project authoring snapshot',
    summary: 'Reads the current Project source revision, state, identity, and preview projection for one GUID.',
    realm: 'build',
    argsSchema: sourceSnapshotSchema,
    resultSchema: sourceSnapshotResultSchema,
    evidence: [],
  },
  async ({ subject }) => {
    if (subject.kind === 'material') {
      const path = join(MATERIAL_ROOT, `${subject.guid}.json`);
      const bytes = await text(path);
      if (bytes === undefined) return domainFailure({ code: 'authoring-subject-missing', expected: 'an existing Project material source', hint: `Project material ${subject.guid} is unavailable.` });
      try {
        const state = JSON.parse(bytes) as MaterialState;
        return { ok: true, value: makeSourceSnapshot({ subject, revision: revision(bytes), state, identity: { sourcePath: relative(PROJECT_ROOT, path).replace(/\\/g, '/') } }) };
      } catch {
        return domainFailure({ code: 'authoring-source-invalid', expected: 'valid JSON Project material source', hint: `Project material ${subject.guid} is invalid.` });
      }
    }

    if (subject.kind === 'mesh') {
      const located = await findMeshSource(subject.guid);
      if (located === undefined) return domainFailure({ code: 'mesh-source-missing', expected: `a Project Mesh Meta containing ${subject.guid}`, hint: 'The Project Mesh source is unavailable; refresh the Project catalog before retrying.' });
      const bytes = await text(located.path);
      if (bytes === undefined) return domainFailure({ code: 'authoring-subject-missing', expected: 'a readable Project Mesh Meta source', hint: `Project Mesh ${subject.guid} is unavailable.` });
      return {
        ok: true,
        value: makeSourceSnapshot({
          subject,
          revision: revision(bytes),
          state: located.state,
          identity: {
            sourcePath: relative(PROJECT_ROOT, located.path).replace(/\\/g, '/'),
            sourceKey: located.sourceKey,
            ...(located.sourceIndex === undefined ? {} : { sourceIndex: located.sourceIndex }),
            ...(typeof located.meta.importer === 'string' ? { importer: located.meta.importer } : {}),
          },
        }),
      };
    }

    const loaded = await vfxCurrent(subject.guid);
    if (loaded === undefined) return domainFailure({ code: 'vfx-source-invalid', expected: 'a readable ParticleEffectSourceV2 Project source', hint: 'The VFX source is missing or invalid.' });
    return {
      ok: true,
      value: makeSourceSnapshot({
        subject,
        revision: revision(loaded.bytes),
        state: loaded.state,
        identity: { sourcePath: relative(PROJECT_ROOT, VFX_PACK).replace(/\\/g, '/'), sourceIndex: loaded.index },
      }),
    };
  },
);

async function vfxModules(): Promise<Readonly<Record<string, ParticleCodeModuleSet>>> {
  const modules: Record<string, ParticleCodeModuleSet> = {};
  for (const path of await files(VFX_ROOT)) {
    if (!path.endsWith('.vfx.wgsl')) continue;
    const name = path.slice(VFX_ROOT.length + 1).replace(/\\/g, '/');
    modules[name] = { entry: await readFile(path, 'utf8') };
  }
  return modules;
}

type VfxCookProduct = Awaited<ReturnType<typeof cookParticleCodeEffect>>;

async function cookVfx(source: VfxState): Promise<VfxCookProduct> {
  const modules = await vfxModules();
  const direct = await cookParticleCodeEffect(source, modules);
  if (direct.ok || !JSON.stringify(direct.error.detail ?? '').includes('Vite module runner has been closed')) return direct;

  // The standalone host can be torn down while a Vite module runner is still
  // in flight.  Keep the same compiler and module catalog, but retry once in
  // a short-lived Bun process so the source transaction remains deterministic.
  const child = spawnSync(process.execPath, [VFX_COOKER], {
    cwd: PROJECT_ROOT,
    input: JSON.stringify(source),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0 || typeof child.stdout !== 'string') return direct;
  try {
    const parsed = JSON.parse(child.stdout) as {
      readonly ok?: unknown;
      readonly product?: {
        readonly asset: unknown;
        readonly refs: readonly string[];
        readonly artifact: {
          readonly artifactKey: string;
          readonly mimeType: 'application/vnd.forgeax.vfx-program+json';
          readonly fingerprint: string;
          readonly bytes: readonly number[];
          readonly program: unknown;
        };
      };
      readonly error?: unknown;
    };
    if (parsed.ok !== true || parsed.product === undefined) return direct;
    return {
      ok: true,
      value: {
        asset: parsed.product.asset as never,
        refs: parsed.product.refs,
        artifact: {
          artifactKey: parsed.product.artifact.artifactKey as never,
          mimeType: parsed.product.artifact.mimeType,
          fingerprint: parsed.product.artifact.fingerprint,
          bytes: new Uint8Array(parsed.product.artifact.bytes),
          program: parsed.product.artifact.program as never,
        },
      },
    } as unknown as VfxCookProduct;
  } catch {
    return direct;
  }
}

const vfx = defineTool<UpdateArgs<VfxState, VfxPatch>, UpdateResult<VfxState>>(
  {
    id: 'vfx.author.update',
    title: 'Update VFX source',
    summary: 'Validates, CAS-writes, and republishes a ParticleEffectSourceV2 source.',
    realm: 'build',
    argsSchema: schema('{ subject: { kind: \'vfx\', guid: string }, snapshot: { revision: string, state: object }, expectedRevision: string, patch: { source: ParticleEffectSourceV2 } }', 'vfx'),
    resultSchema: resultSchema<VfxState>(),
    evidence: [],
  },
  async ({ subject, expectedRevision, patch }) => {
    const loaded = await vfxCurrent(subject.guid);
    if (loaded === undefined) return domainFailure({ code: 'vfx-source-invalid', expected: 'a readable ParticleEffectSourceV2 Project source', hint: 'The VFX source is missing or invalid.' });
    const beforeRevision = revision(loaded.bytes);
    const normalizedExpectedRevision = normalizeRevision(expectedRevision);
    if (beforeRevision !== normalizedExpectedRevision) return domainFailure({ code: 'vfx-source-revision-conflict', expected: normalizedExpectedRevision, current: beforeRevision, draft: loaded.state, hint: 'The VFX source changed; refresh before retrying.' });
    const parsed = parseParticleEffectSourceV2(patch.source);
    if (!parsed.ok) return domainFailure({ code: 'vfx-source-invalid', expected: 'ParticleEffectSourceV2 schemaVersion 2', hint: parsed.error.hint });
    const cooked = await cookVfx(parsed.value);
    if (!cooked.ok) {
      return domainFailure({
        code: cooked.error.code,
        expected: cooked.error.expected,
        hint: `${cooked.error.code}: ${cooked.error.hint}`,
      });
    }
    const assets = loaded.root.assets as readonly unknown[];
    const nextRoot: RecordValue = {
      ...loaded.root,
      assets: assets.map((asset, index) => index === loaded.index && record(asset) ? { ...asset, payload: parsed.value } : asset),
    };
    const bytes = `${JSON.stringify(nextRoot, null, 2)}\n`;
    const nextRevision = revision(bytes);
    const cookPath = join(COOK_ROOT, 'vfx', subject.guid, 'particle-effect', 'program.json');
    const previousPack = loaded.bytes;
    const previousArtifact = await readFile(cookPath).catch(() => undefined);
    try {
      await atomic(VFX_PACK, bytes);
      await atomicBytes(cookPath, cooked.value.artifact.bytes);
    } catch (cause) {
      await atomic(VFX_PACK, previousPack).catch(() => undefined);
      if (previousArtifact === undefined) await unlink(cookPath).catch(() => undefined);
      else await atomicBytes(cookPath, previousArtifact).catch(() => undefined);
      return domainFailure({
        code: 'authoring-publication-failed',
        expected: 'the VFX source and particle-effect/program.json receipt to publish atomically',
        hint: cause instanceof Error ? cause.message : 'VFX publication failed; retry from the source snapshot.',
      });
    }
    return {
      subject,
      beforeRevision,
      afterRevision: nextRevision,
      state: parsed.value,
      receipts: [relative(PROJECT_ROOT, cookPath).replace(/\\/g, '/')],
      sourceIdentity: {
        sourcePath: relative(PROJECT_ROOT, VFX_PACK).replace(/\\/g, '/'),
        sourceIndex: loaded.index,
      },
      previewBinding: previewBinding(subject, nextRevision, {
        sourcePath: relative(PROJECT_ROOT, VFX_PACK).replace(/\\/g, '/'),
        sourceIndex: loaded.index,
      }),
    };
  },
);

const plugin: Plugin = { name: 'sample-authoring', apply() {} };
export default defineToolPlugin(plugin, [readSourceSnapshotTool, material, mesh, vfx] as readonly ToolContribution<unknown, unknown>[]);
