// applyCommand — world-based imperative mutation.
//
// Handle IS identity: document appliers write the engine world directly, and
// op payloads carry EntityHandles. A spawnEntity may carry a NEGATIVE
// placeholder `_id` used only to forward-reference the not-yet-spawned entity
// WITHIN a single transaction (e.g. groupSelected: spawn a group, then reparent
// children under it). That forward-reference is resolved by a
// transaction-scoped alias map (DocAliasMap) — ephemeral, created per top-level
// dispatch and discarded after. After a spawn applier runs it rewrites
// cmd._id in place to the real engine handle so the committed ledger op and
// any post-dispatch reader (spawnClipboard selection) see the concrete handle.
//
// childrenOf walks a World via the engine Children component (activeWorld read
// face). Root entities are worldRootHandles — entities with no live ChildOf
// parent.

import type {
  ApplyResult,
  CommandError,
  EditorOp,
  EditSession,
} from '../types';
import type { SceneAsset } from '@forgeax/engine-types';

import { ChildOf, Children, Name, Transform } from '@forgeax/engine-scene';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { getRegisteredComponents, resolveComponent } from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';
import { Visibility, VisibilityStateValue, visibilityStateFromU32, type VisibilityState } from '../visibility';
import { EngineFacade } from '../io/engine-facade';
import { assetIO } from '../io/asset-io-facade';
import { worldRootHandles } from '../store/entity-state';
import { getComponentSchema, type FieldSchema } from '../scene/schema';
import { planGroupedArrayPatch } from '../scene/array-edit';

export { createEditSession } from './edit-session';

/** Apply one document operation and expose its inverse as a canonical effect.
 * The gateway uses the same result for deferred history publication, so an
 * effect cannot be published without a concrete inverse from this applier. */
export function applyCanonicalDocumentEffect(
  session: EditSession,
  command: EditorOp,
  revision: string,
): ApplyResult & { readonly revision?: string } {
  const result = applyCommand(session, command);
  return result.ok ? { ...result, revision } : result;
}

// ── IoC context for document appliers ────────────────────────────────────────
// Document appliers receive a `DocApplierCtx` whose ONLY world access is the
// controlled `engine` proxy (routes every write through EngineFacade →
// records its engine interface leaf onto the active span). `ctx.world` does
// not exist — writing it is a tsc error (guarded by ctx-world-negative test).

/** Typed engine-write proxy handed to document appliers via `ctx.engine`.
 *  Structurally the EngineFacade instance, typed as a `Pick<>` of the facade's
 *  own method surface so appliers keep type safety on reads without ever
 *  holding a raw `world` handle. Facade-only methods (e.g.
 *  `instantiateSceneAssetFlat`, which needs the registry) are reachable while
 *  a raw `world` remains inaccessible. */
export type EngineWriteProxy = Pick<
  EngineFacade,
  'get' | 'getSceneInstanceState' | 'set' | 'setSceneOverride' | 'removeSceneOverride' | 'spawn' | 'despawn' | 'addComponent' | 'removeComponent' | 'instantiateSceneAssetFlat' | 'resolveSharedGuid' | 'isAssetCatalogued' | 'invalidateAsset' | 'patchLiveMaterialParams'
>;

/** Transaction-scoped spawn-placeholder alias.
 *  A spawnEntity op may carry a NEGATIVE placeholder `_id` so a later sub-op in
 *  the SAME transaction can reference the not-yet-spawned entity (e.g.
 *  groupSelected: spawn group first, then reparent children under it). The
 *  spawn applier records placeholder → real handle here; toEntity resolves a
 *  negative reference through it. Positive references ARE handles and pass
 *  through unchanged. Created per top-level dispatch and discarded after — no
 *  session-lifetime identity state. */
export type DocAliasMap = Map<number, EntityHandle>;

/** Read-side query snapshot function shape (mirrors io/query-snapshot's
 *  QuerySnapshotFn). Kept structural here to avoid a session→io type import;
 *  document appliers don't consume it, but it is part of the established M2 ctx
 *  contract (t12a) so it stays on the ctx. */
export type DocQueryFn = (descriptor: unknown) => unknown;

/** The IoC context every DOCUMENT applier receives (plan-strategy §2 D-2).
 *  engine (controlled write proxy) + alias (transaction placeholder resolution)
 *  + dispatchSub (recursive transaction dispatch) + query (read side, carried for
 *  the M2 ctx contract). Deliberately NO `world` field — `ctx.world` in an
 *  applier body is a tsc error (AC-01 negative; ctx-world-negative guard). */
export interface DocApplierCtx {
  engine: EngineWriteProxy;
  /** Asset/pack write gate (north-star §2 axis symmetry with engine). Document
   *  appliers such as destroyAsset reach pack IO through this. */
  assetIO: import('../io/asset-io-facade').AssetIOFacade;
  alias: DocAliasMap;
  dispatchSub(ctx: DocApplierCtx, sub: EditorOp): ApplyResult;
  query: DocQueryFn;
}

// ── Component token resolution ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CToken = any;

const _cmpCache = new Map<string, CToken | undefined>();

function resolveToken(name: string): CToken | undefined {
  const cached = _cmpCache.get(name);
  if (cached !== undefined || _cmpCache.has(name)) return cached;
  const tok = getRegisteredComponents().get(name);
  _cmpCache.set(name, tok);
  return tok;
}
(function _seedCache() {
  _cmpCache.set('Name', Name);
  _cmpCache.set('Transform', Transform);
  _cmpCache.set('ChildOf', ChildOf);
  _cmpCache.set('Visibility', Visibility);
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function clone<T>(v: T): T {
  return structuredClone(v);
}

type ComponentWriteValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly hint: string; readonly details: Record<string, unknown> };

function isArrayLikeValue(value: unknown): value is ArrayLike<unknown> {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

function componentFieldSchema(component: string, field: string): FieldSchema | undefined {
  return getComponentSchema(component)?.fields.find((candidate) => candidate.key === field);
}

function rawComponentSchema(component: string): Record<string, string> | undefined {
  const token = resolveComponent(component) as { schema?: Record<string, string> } | undefined;
  return token?.schema;
}

function arrayFieldInfo(component: string, field: string): { rawType: string; schema?: FieldSchema } | undefined {
  const rawType = rawComponentSchema(component)?.[field];
  if (typeof rawType !== 'string' || !rawType.startsWith('array<')) return undefined;
  return { rawType, schema: componentFieldSchema(component, field) };
}

function arrayLength(value: unknown): number | null {
  return isArrayLikeValue(value) ? value.length : null;
}

function fixedArrayLength(rawType: string): number | undefined {
  const match = /^array<[^,>]+,\s*(\d+)>$/.exec(rawType);
  return match === null ? undefined : Number(match[1]);
}

function arrayElementType(rawType: string): string | undefined {
  if (!rawType.startsWith('array<') || !rawType.endsWith('>')) return undefined;
  const inner = rawType.slice('array<'.length, -1);
  const capacity = /^(.*),\s*\d+$/.exec(inner);
  return (capacity?.[1] ?? inner).trim();
}

function invalidScalarValue(rawType: string, value: unknown): { expected: string; reason: string } | null {
  if (rawType === 'f32' || rawType === 'i32' || rawType === 'u32') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { expected: rawType, reason: 'number-required' };
    }
    if ((rawType === 'i32' || rawType === 'u32') && !Number.isInteger(value)) {
      return { expected: rawType, reason: 'integer-required' };
    }
    if (rawType === 'u32' && (value < 0 || value > 0xffffffff)) {
      return { expected: rawType, reason: 'range' };
    }
    if (rawType === 'i32' && (value < -0x80000000 || value > 0x7fffffff)) {
      return { expected: rawType, reason: 'range' };
    }
    return null;
  }
  if (rawType === 'bool' && typeof value !== 'boolean') {
    return { expected: rawType, reason: 'boolean-required' };
  }
  if (rawType === 'string' && typeof value !== 'string') {
    return { expected: rawType, reason: 'string-required' };
  }
  if (rawType === 'enum' && (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value))) {
    return { expected: rawType, reason: 'enum-number-required' };
  }
  // Shared refs accept a live numeric handle or a catalog GUID string; the
  // latter is resolved by resolveSharedFields after this validation boundary.
  if (/^shared<[^<>]+>$/.test(rawType)) {
    if (typeof value === 'string') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return null;
    return { expected: rawType, reason: 'shared-handle-or-guid-required' };
  }
  if (rawType === 'entity') {
    if (value === null) return null;
    if (typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)) return null;
    return { expected: rawType, reason: 'entity-handle-required' };
  }
  return null;
}

function invalidFieldValue(rawType: string, value: unknown): { expected: string; reason: string; index?: number } | null {
  const elementType = arrayElementType(rawType);
  if (elementType === undefined) return invalidScalarValue(rawType, value);
  if (!isArrayLikeValue(value)) return { expected: rawType, reason: 'array-required' };
  const values = Array.from(value);
  for (const [index, element] of values.entries()) {
    const invalid = invalidScalarValue(elementType, element);
    if (invalid !== null) return { ...invalid, index };
  }
  return null;
}

function defaultArrayElement(field: FieldSchema): unknown {
  if (field.arrayElementDefault !== undefined) return clone(field.arrayElementDefault);
  const elementType = field.arrayMeta?.elementType ?? '';
  if (elementType === 'bool') return false;
  if (elementType === 'string') return '';
  return 0;
}

type CompleteGroupedArrays =
  | { readonly ok: true; readonly values: Record<string, unknown> }
  | { readonly ok: false; readonly hint: string; readonly details: Record<string, unknown> };

/** Fill omitted members of a producer-declared parallel group from the engine
 * state (or schema defaults when adding a new component). A partial patch that
 * changes an already-populated group to a different length remains a precise
 * field-path error; array add/remove/reorder callers use the pure planner and
 * send one complete patch explicitly. */
function completeGroupedArrays(
  component: string,
  values: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
): CompleteGroupedArrays {
  const fields = getComponentSchema(component)?.fields ?? [];
  const groups = new Map<string, FieldSchema[]>();
  for (const field of fields) {
    if (field.arrayGroup === undefined) continue;
    const group = groups.get(field.arrayGroup) ?? [];
    group.push(field);
    groups.set(field.arrayGroup, group);
  }
  const complete = { ...values };
  for (const [groupName, groupFields] of groups) {
    const provided = groupFields.filter((field) => field.key in values);
    if (provided.length === 0) continue;
    const providedLengths = provided.map((field) => ({ field: field.key, length: arrayLength(values[field.key]) }));
    if (providedLengths.some((entry) => entry.length === null)) continue;
    const expected = providedLengths[0]!.length;
    if (expected === null) continue;
    const mismatch = providedLengths.find((entry) => entry.length !== expected);
    if (mismatch !== undefined) {
      const fieldPath = `${component}.${mismatch.field}`;
      return {
        ok: false,
        hint: `parallel arrays in ${groupName} must share one length; ${fieldPath} has ${mismatch.length}, expected ${expected}`,
        details: { fieldPath, reason: 'parallel-array-length', group: groupName, lengths: providedLengths },
      };
    }

    const baseLengths = base === undefined
      ? []
      : groupFields.map((field) => ({ field: field.key, length: arrayLength(base[field.key]) }));
    const baseExpected = baseLengths.length > 0 && baseLengths.every((entry) => entry.length !== null && entry.length === baseLengths[0]!.length)
      ? baseLengths[0]!.length
      : null;
    if (provided.length !== groupFields.length && baseExpected !== null && baseExpected > 0 && expected !== baseExpected) {
      const fieldPath = `${component}.${provided[0]!.key}`;
      return {
        ok: false,
        hint: `${fieldPath} changes a populated ${groupName} group from ${baseExpected} to ${expected} items; use one complete group patch`,
        details: {
          fieldPath,
          reason: 'parallel-array-length',
          group: groupName,
          lengths: groupFields.map((field) => ({ field: field.key, length: field.key in values ? arrayLength(values[field.key]) : arrayLength(base?.[field.key]) })),
        },
      };
    }
    for (const field of groupFields) {
      if (field.key in values) continue;
      if (baseExpected !== null && baseExpected === expected) {
        complete[field.key] = clone(base?.[field.key]);
      } else {
        complete[field.key] = Array.from({ length: expected }, () => defaultArrayElement(field));
      }
    }
  }
  return { ok: true, values: complete };
}

/** Validate the complete authoring boundary before the engine gets a partial
 * write. `details.fieldPath` is the machine-readable breadcrumb; callers must
 * not parse the human hint. */
function validateComponentWrite(
  component: string,
  values: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
  code: 'SET_FAILED' | 'ADD_FAILED',
): ComponentWriteValidation {
  const schema = rawComponentSchema(component);
  if (schema === undefined) {
    return { ok: false, hint: `unknown component ${component}`, details: { fieldPath: component } };
  }

  for (const [field, value] of Object.entries(values)) {
    if (!(field in schema)) {
      const fieldPath = `${component}.${field}`;
      return {
        ok: false,
        hint: `${code === 'SET_FAILED' ? 'setComponent' : 'addComponent'} rejected unknown field ${fieldPath}`,
        details: { fieldPath, reason: 'unknown-field', knownFields: Object.keys(schema).sort() },
      };
    }
    const arrayInfo = arrayFieldInfo(component, field);
    const fieldPath = `${component}.${field}`;
    const invalid = invalidFieldValue(schema[field]!, value);
    if (invalid !== null) {
      return {
        ok: false,
        hint: `${fieldPath} requires ${invalid.expected} (${invalid.reason})`,
        details: {
          fieldPath,
          reason: 'type-mismatch',
          expected: invalid.expected,
          actual: Array.isArray(value) || ArrayBuffer.isView(value) ? 'array' : typeof value,
          ...(invalid.index === undefined ? {} : { index: invalid.index }),
        },
      };
    }
    const enumOptions = componentFieldSchema(component, field)?.enumOptions;
    if (enumOptions !== undefined && !enumOptions.some((option) => option.value === value)) {
      const fieldPath = `${component}.${field}`;
      return {
        ok: false,
        hint: `${fieldPath} requires one of the producer-declared enum values (${enumOptions.map((option) => `${option.value}=${option.label}`).join(', ')})`,
        details: {
          fieldPath,
          reason: 'enum-value',
          allowed: enumOptions.map((option) => option.value),
          labels: Object.fromEntries(enumOptions.map((option) => [option.label, option.value])),
          actual: value,
        },
      };
    }
    if (arrayInfo === undefined) continue;
    const length = arrayLength(value);
    if (length === null) {
      return {
        ok: false,
        hint: `${fieldPath} requires an array value`,
        details: { fieldPath, reason: 'array-required' },
      };
    }
    const capacity = fixedArrayLength(arrayInfo.rawType);
    if (capacity !== undefined && length !== capacity) {
      return {
        ok: false,
        hint: `${fieldPath} requires exactly ${capacity} items (received ${length})`,
        details: { fieldPath, reason: 'fixed-array-length', expectedLength: capacity, actualLength: length },
      };
    }
  }

  const effective = base === undefined ? values : { ...base, ...values };
  const schemaFields = getComponentSchema(component)?.fields ?? [];
  const groups = new Map<string, FieldSchema[]>();
  for (const field of schemaFields) {
    if (field.arrayGroup === undefined) continue;
    const group = groups.get(field.arrayGroup) ?? [];
    group.push(field);
    groups.set(field.arrayGroup, group);
  }
  for (const [groupName, fields] of groups) {
    if (!fields.some((field) => field.key in values)) continue;
    const lengths = fields.map((field) => ({ field: field.key, length: arrayLength(effective[field.key]) }));
    if (lengths.some((entry) => entry.length === null)) {
      const culprit = lengths.find((entry) => entry.length === null)!.field;
      const fieldPath = `${component}.${culprit}`;
      return {
        ok: false,
        hint: `${fieldPath} must be present with the other ${groupName} parallel arrays`,
        details: { fieldPath, reason: 'parallel-array-missing', group: groupName, lengths },
      };
    }
    const expected = lengths[0]!.length;
    const mismatch = lengths.find((entry) => entry.length !== expected);
    if (mismatch !== undefined) {
      const fieldPath = `${component}.${mismatch.field}`;
      return {
        ok: false,
        hint: `parallel arrays in ${groupName} must share one length; ${fieldPath} has ${mismatch.length}, expected ${expected}`,
        details: { fieldPath, reason: 'parallel-array-length', group: groupName, lengths },
      };
    }
  }
  return { ok: true };
}

function spawnComponentData(
  name: string,
  parent: EntityHandle | null,
  extraComponents?: Record<string, unknown>,
): Array<{ component: CToken; data: Record<string, unknown> }> {
  const transformDefaults: Record<string, unknown> = {
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
  if (extraComponents?.Transform) {
    Object.assign(transformDefaults, extraComponents.Transform as Record<string, unknown>);
  }
  const out: Array<{ component: CToken; data: Record<string, unknown> }> = [
    { component: Name, data: { value: name } },
    { component: Transform, data: transformDefaults },
  ];
  if (parent !== null) {
    out.push({ component: ChildOf, data: { parent } });
  }
  // Half B (AC-11 / Finding 9): 'Children' stays OUT of the editor's spawn-time
  // vocabulary. The engine's ChildOf mirror hook is the SOLE writer of Children,
  // so a rebuilt node (duplicateEntity: entComponents -> spawnComponentData)
  // must NOT re-author Children or it would double-write. On the dedup-absent
  // baseline (main HEAD) BASELINE_NAMES already omits 'Children'; keeping it out
  // of this skip-set-plus-author path is the verify-absence guarantee.
  const BASELINE_NAMES = new Set(['Name', 'Transform', 'ChildOf']);
  // verify F-1 (round 1): `Editor*`-prefixed keys are intentional transient
  // editor-side markers (e.g. `EditorPendingMeshAsset`, carrying a real GUID for
  // the edit-runtime drag-spawn resolver to consume via `lastCommand.components`
  // BEFORE this drop happens). They are DESIGNED never to reach the world — so
  // dropping them here is expected, not the data-loss case below.
  const isIntentionalEditorMarker = (n: string): boolean => n.startsWith('Editor');
  if (extraComponents) {
    let hasMeshFilter = false;
    for (const [compName, value] of Object.entries(extraComponents)) {
      if (BASELINE_NAMES.has(compName)) continue;
      if (compName === 'Children') continue; // Half B: engine owns Children mirror
      if (isIntentionalEditorMarker(compName)) continue;
      const tok = resolveToken(compName);
      if (tok) {
        out.push({ component: tok, data: (value ?? {}) as Record<string, unknown> });
        if (compName === 'MeshFilter') hasMeshFilter = true;
      } else {
        // charter P3 — fail loud, never silently drop: an unregistered component
        // name means an UPSTREAM producer still emits a vocabulary this collapse
        // deleted. Warn so the divergence surfaces at author time instead of as a
        // mysteriously empty entity on reopen (AGENTS.md #2 data-loss).
        console.warn(
          `[editor] spawnComponentData: unknown component '${compName}' dropped — ` +
          `upstream producer still emits a component this editor does not register. ` +
          `Migrate it to an engine-native component (MeshFilter/MeshRenderer/Transform/…).`,
        );
      }
    }
    if (hasMeshFilter && !(extraComponents as Record<string, unknown>).MeshRenderer) {
      // Attach an EMPTY MeshRenderer so the entity is renderable WITHOUT minting a
      // synthetic material. The engine's render walk is gated on MeshRenderer
      // presence, so a MeshFilter-only entity is archetype-absent and never drawn.
      // An empty `materials: []` routes through the engine's OWN default-material
      // fallback (identical in Edit and Play) and serializes with zero material
      // handles to resolve, so save never sees an unresolved handle.
      out.push({
        component: MeshRenderer as unknown as CToken,
        data: { materials: [] },
      });
    }
  }
  return out;
}

// ── Handle resolution (transaction placeholder alias) ───────────────────────

// A reference in an op payload is either a real engine handle (>= 0) or a
// negative transaction placeholder that resolves through the alias map. Real
// engine handles are always non-negative (packed slot+generation), so the sign
// unambiguously discriminates the two.
function toEntity(alias: DocAliasMap, ref: number): EntityHandle {
  if (ref < 0) {
    const h = alias.get(ref);
    return (h ?? ref) as EntityHandle;
  }
  return ref as EntityHandle;
}

// ── Per-op document appliers (plan-strategy §2 D-1) ─────────────────────────

// ── spawnEntity applier ─────────────────────────────────────────────────────

export function applySpawnEntity(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  const { engine, alias } = ctx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  // A negative _id is a transaction placeholder (forward-reference); a
  // non-negative _id is a concrete handle from a prior apply (redo / inverse).
  const placeholder: number | undefined =
    typeof cmd._id === 'number' && cmd._id < 0 ? (cmd._id as number) : undefined;
  const parent = cmd.parent ?? null;
  const parentEng = parent !== null ? toEntity(alias, parent) : null;
  if (parentEng !== null && !engine.get(parentEng, Name).ok) {
    return { ok: false, error: { code: 'INVALID_PARENT', hint: `parent ${parent} does not exist` } };
  }
  const compData = spawnComponentData(cmd.name ?? 'Entity', parentEng, cmd.components);
  console.info(`[placement-diag] spawn-applier.before ${JSON.stringify({
    name: cmd.name ?? 'Entity',
    parent: parentEng,
    requestedComponents: Object.keys((cmd.components ?? {}) as Record<string, unknown>),
    materializedComponents: compData.map((entry) =>
      (entry.component as unknown as { name?: string }).name ?? 'unknown'),
  })}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = engine.spawn(...(compData as any));
  if (!r.ok) {
    console.error(`[placement-diag] spawn-applier.failed ${JSON.stringify({
      name: cmd.name ?? 'Entity',
      error: String(r.error),
    })}`);
    return { ok: false, error: { code: 'SPAWN_FAILED', hint: String(r.error) } };
  }
  const eH = r.value as EntityHandle;
  console.info(`[placement-diag] spawn-applier.created ${JSON.stringify({
    name: cmd.name ?? 'Entity',
    entity: eH,
    parent: parentEng,
  })}`);
  // Rewrite _id in place to the real handle: the committed ledger op keeps the
  // concrete handle, and a NEGATIVE placeholder must resolve for later sub-ops in
  // the same transaction (alias forward-reference). Post-dispatch readers use the
  // returned `created` channel instead of reading this back.
  cmd._id = eH;
  if (placeholder !== undefined) alias.set(placeholder, eH);
  return { ok: true, inverse: { kind: 'destroyEntity', entity: eH }, created: [eH] };
}

// ── destroyEntity applier ────────────────────────────────────────────────────

export function applyDestroyEntity(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) {
    return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  }
  // Collect subtree via engine handles (eH + Children members).
  const idStack: EntityHandle[] = [eH];
  const visitedEng = new Set<EntityHandle>();
  const subtree: EntityHandle[] = [];
  while (idStack.length > 0) {
    const ce = idStack.pop()!;
    if (visitedEng.has(ce)) continue;
    visitedEng.add(ce);
    subtree.push(ce);
    const chR = engine.get(ce, Children);
    if (chR.ok && chR.value.entities != null) {
      const arr = chR.value.entities as { readonly length: number; [index: number]: number };
      for (let ci = 0; ci < arr.length; ci++) if (!visitedEng.has(arr[ci]! as EntityHandle)) idStack.push(arr[ci]! as EntityHandle);
    }
  }
  // ── Collect legacy component snapshot (fallback path only) ──────────────
  // When _asset is absent (direct applyCommand without Gateway, or collect
  // failure), fall back to the old spawnEntity inverse. The snapshot must be
  // collected BEFORE despawn while the components are still live.
  let legacyEntries: Array<{ name: string; comps: Record<string, unknown> }> | undefined;
  if (!cmd._asset) {
    legacyEntries = [];
    for (const ce of subtree) {
      const nr = engine.get(ce, Name); const nm = nr.ok ? nr.value.value : '?';
      const comps: Record<string, unknown> = {};
      for (const [cn, ct] of [['Transform', Transform], ['ChildOf', ChildOf], ['MeshFilter', MeshFilter], ['Visibility', Visibility]] as [string, CToken][]) {
        const cr = engine.get(ce, ct); if (cr.ok) comps[cn] = clone(cr.value);
      }
      const nc = engine.get(ce, Name); if (nc.ok) comps['Name'] = clone(nc.value);
      legacyEntries.push({ name: nm, comps });
    }
  }

  // Despawn bottom-up (leaves before parents).
  for (const e of [...subtree].reverse()) {
    const dr = engine.despawn(e);
    if (!dr.ok) return { ok: false, error: { code: 'DESPAWN_FAILED', hint: String(dr.error) } };
  }

  // ── Build inverse ──────────────────────────────────────────────────────
  if (cmd._asset) {
    // New path: scene-asset GUID round-trip preserves materials faithfully.
    // instantiateSceneAsset rebuilds the full subtree from the POD; its own
    // inverse is destroyEntity (document.ts:549), closing the undo/redo loop.
    const rootName = cmd._name ?? `Entity ${cmd.entity}`;
    return {
      ok: true,
      inverse: {
        kind: 'instantiateSceneAsset',
        asset: cmd._asset,
        parent: cmd._parent ?? null,
        name: rootName,
        label: `undo destroy ${rootName}`,
      },
      created: [],
    };
  }

  // Fallback: legacy spawnEntity inverse (no _asset — materials will be lost
  // but geometry/names survive). Kept for backward compat with direct
  // applyCommand callers that bypass Gateway pre-collection.
  const spawnCmds: EditorOp[] = legacyEntries!.map((e) => ({
    kind: 'spawnEntity' as const,
    name: e.name, parent: null, components: e.comps,
  }));
  const rootName = legacyEntries![0]?.name ?? `Entity ${cmd.entity}`;
  return { ok: true, inverse: spawnCmds.length === 1 ? spawnCmds[0]! : { kind: 'transaction', label: `undo destroy ${rootName}`, commands: spawnCmds }, created: [] };
}

// ── rename applier ────────────────────────────────────────────────────────────

export function applyRename(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const eH = toEntity(alias, cmd.entity);
  const nameR = engine.get(eH, Name);
  if (!nameR.ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const before = nameR.value.value;
  const r = engine.set(eH, Name, { value: cmd.name });
  if (!r.ok) return { ok: false, error: { code: 'RENAME_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'rename', entity: cmd.entity, name: before }, created: [] };
}

// ── reparent applier ──────────────────────────────────────────────────────────

export function applyReparent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const parentEng = cmd.parent !== null ? toEntity(alias, cmd.parent) : null;
  if (cmd.parent !== null && !engine.get(parentEng!, Name).ok) {
    return { ok: false, error: { code: 'INVALID_PARENT', hint: `parent ${cmd.parent} not found` } };
  }
  if (parentEng !== null && parentEng === eH) {
    return { ok: false, error: { code: 'INVALID_PARENT', hint: 'cannot parent an entity to itself' } };
  }
  const coR = engine.get(eH, ChildOf);
  // Inverse carries the prior parent HANDLE (handle IS identity now — no legacy
  // id translation). null when the entity was previously a root.
  const before: EntityHandle | null = coR.ok ? (coR.value.parent as EntityHandle) : null;
  if (parentEng !== null) {
    // ChildOf is a relationship (exclusive arm): reparent MUST go through
    // addComponent so the engine's relationship hook fires and keeps the
    // bidirectional Children mirror in sync (remove-from-old + add-to-new). A
    // bare engine.set skips the exclusive-arm handling and desyncs Children (the
    // node-hidden bug: feedbacks/2026-07-07-hierarchy-reparent-children-desync-
    // node-hidden.md §6/§8). Routes through ctx.engine so the write records its
    // leaf on the active span (AC-09).
    const r = engine.addComponent(eH, { component: ChildOf, data: { parent: parentEng } });
    if (!r.ok) return { ok: false, error: { code: 'REPARENT_FAILED', hint: String(r.error) } };
  } else if (coR.ok) {
    const r = engine.removeComponent(eH, ChildOf);
    if (!r.ok) return { ok: false, error: { code: 'REPARENT_FAILED', hint: String(r.error) } };
  }
  return { ok: true, inverse: { kind: 'reparent', entity: cmd.entity, parent: before }, created: [] };
}

// ── setComponent applier ──────────────────────────────────────────────────────

export function applySetComponent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const cur = engine.get(eH, tok);
  if (!cur.ok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.entity}` } };
  // Guard `patch` before Object.keys — a missing/null/non-object patch (e.g. a
  // caller that passed addComponent's `value` field by mistake) must return a
  // structured INVALID_ARGS, never throw a raw `Cannot convert undefined or null
  // to object` TypeError. gateway.dispatch validates this at the door now, but
  // ctx.dispatchSub (transaction sub-ops) and gateway.begin bypass the door, so
  // the applier stays the innermost invariant point (solo round-14).
  if (typeof cmd.patch !== 'object' || cmd.patch === null || Array.isArray(cmd.patch)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: `setComponent requires an object "patch" field (got ${cmd.patch === null ? 'null' : Array.isArray(cmd.patch) ? 'array' : typeof cmd.patch}); note setComponent uses "patch", addComponent uses "value"` } };
  }
  const before = clone(cur.value) as Record<string, unknown>;
  const completed = completeGroupedArrays(cmd.component, cmd.patch as Record<string, unknown>, before);
  if (!completed.ok) return { ok: false, error: { code: 'SET_FAILED', hint: completed.hint, details: completed.details } };
  const patch = completed.values;
  const validation = validateComponentWrite(cmd.component, patch, before, 'SET_FAILED');
  if (!validation.ok) return { ok: false, error: { code: 'SET_FAILED', hint: validation.hint, details: validation.details } };
  const restore: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) restore[k] = before[k];
  // Front-door shared<T> binder (M7 / AC-10): resolve any catalogued GUID strings
  // in shared fields of the patch to live handles first (same step as
  // applyAddComponent — the setComponent path binds a clip onto an existing
  // AnimationPlayer). Fail Fast on a resolve miss; never pass the string to set().
  const resolvedPatch = resolveSharedFields(engine, cmd.component, patch);
  if (!resolvedPatch.ok) return { ok: false, error: { code: 'SET_FAILED', hint: resolvedPatch.hint } };
  const r = engine.set(eH, tok, resolvedPatch.value as Parameters<typeof engine.set>[2]);
  if (!r.ok) return { ok: false, error: { code: 'SET_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'setComponent', entity: cmd.entity, component: cmd.component, patch: restore }, created: [] };
}

// ── SceneInstance override appliers ─────────────────────────────────────────
//
// SceneInstance members are engine-derived entities. Their authored edit is
// still a document operation, but the write must enter the engine's
// setSceneOverride/removeSceneOverride owner so the runtime state and the
// mount override collector observe exactly the same fact.

export function applySetSceneOverride(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as {
    kind: 'setSceneOverride';
    root: number;
    member: number;
    component: string;
    field: string;
    value: unknown;
    _beforeHadOverride?: boolean;
    _beforeOverride?: unknown;
  };
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const root = toEntity(ctx.alias, cmd.root);
  const member = toEntity(ctx.alias, cmd.member);
  const state = ctx.engine.getSceneInstanceState(root);
  if (!state.ok) return { ok: false, error: { code: 'SET_FAILED', hint: `entity ${cmd.root} is not a SceneInstance root`, details: { fieldPath: `SceneInstance(${cmd.root})`, reason: 'scene-instance-root-required' } } };
  const localId = state.value.entityToLocalId.get(member);
  if (localId === undefined) {
    return { ok: false, error: { code: 'SET_FAILED', hint: `entity ${cmd.member} is not a member of SceneInstance ${cmd.root}`, details: { fieldPath: `SceneInstance(${cmd.root}).member`, reason: 'member-not-in-instance' } } };
  }
  const current = ctx.engine.get(member, tok);
  if (!current.ok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.member}` } };
  const before = clone(current.value) as Record<string, unknown>;
  const field = getComponentSchema(cmd.component)?.fields.find((candidate) => candidate.key === cmd.field);
  let patch: Record<string, unknown> = { [cmd.field]: cmd.value };
  if (field?.arrayMeta !== undefined) {
    const planned = planGroupedArrayPatch({ component: cmd.component, field: cmd.field, value: cmd.value }, before);
    if (!planned.ok) {
      return { ok: false, error: { code: 'SET_FAILED', hint: planned.hint, details: { fieldPath: planned.fieldPath, reason: planned.reason } } };
    }
    patch = planned.patch;
  }
  const validation = validateComponentWrite(cmd.component, patch, before, 'SET_FAILED');
  if (!validation.ok) return { ok: false, error: { code: 'SET_FAILED', hint: validation.hint, details: validation.details } };
  const resolved = resolveSharedFields(ctx.engine, cmd.component, patch);
  if (!resolved.ok) return { ok: false, error: { code: 'SET_FAILED', hint: resolved.hint } };
  const previous = new Map<string, unknown>();
  for (const fieldName of Object.keys(patch)) {
    const existing = state.value.overrides.get(localId)?.get(`${cmd.component}:${fieldName}`);
    if (existing !== undefined) previous.set(fieldName, clone(existing.value));
  }
  const applied: string[] = [];
  for (const fieldName of Object.keys(patch)) {
    const result = ctx.engine.setSceneOverride(root, member, tok, fieldName, resolved.value[fieldName]);
    if (!result.ok) {
      for (const appliedField of [...applied].reverse()) {
        const oldValue = previous.get(appliedField);
        if (oldValue === undefined) ctx.engine.removeSceneOverride(root, member, tok, appliedField);
        else ctx.engine.setSceneOverride(root, member, tok, appliedField, oldValue);
      }
      return { ok: false, error: { code: 'SET_FAILED', hint: String(result.error), details: { fieldPath: `${cmd.component}.${fieldName}`, reason: 'engine-scene-override-rejected' } } };
    }
    applied.push(fieldName);
  }
  const inverseCommands: EditorOp[] = Object.keys(patch).map((fieldName) => {
    const oldValue = previous.get(fieldName);
    return oldValue === undefined
      ? { kind: 'removeSceneOverride', root: cmd.root, member: cmd.member, component: cmd.component, field: fieldName }
      : { kind: 'setSceneOverride', root: cmd.root, member: cmd.member, component: cmd.component, field: fieldName, value: oldValue };
  });
  const inverse: EditorOp = inverseCommands.length === 1
    ? inverseCommands[0]!
    : { kind: 'transaction', label: `restore override ${cmd.component} ×${inverseCommands.length}`, commands: [...inverseCommands].reverse() };
  return { ok: true, inverse, created: [] };
}

export function applyRemoveSceneOverride(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as {
    kind: 'removeSceneOverride';
    root: number;
    member: number;
    component: string;
    field: string;
  };
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const root = toEntity(ctx.alias, cmd.root);
  const member = toEntity(ctx.alias, cmd.member);
  const state = ctx.engine.getSceneInstanceState(root);
  if (!state.ok) return { ok: false, error: { code: 'SET_FAILED', hint: `entity ${cmd.root} is not a SceneInstance root`, details: { fieldPath: `SceneInstance(${cmd.root})`, reason: 'scene-instance-root-required' } } };
  const localId = state.value.entityToLocalId.get(member);
  if (localId === undefined) {
    return { ok: false, error: { code: 'SET_FAILED', hint: `entity ${cmd.member} is not a member of SceneInstance ${cmd.root}`, details: { fieldPath: `SceneInstance(${cmd.root}).member`, reason: 'member-not-in-instance' } } };
  }
  const existing = state.value.overrides.get(localId)?.get(`${cmd.component}:${cmd.field}`);
  if (existing === undefined) {
    return { ok: false, error: { code: 'SET_FAILED', hint: `no SceneInstance override exists for ${cmd.component}.${cmd.field} on entity ${cmd.member}`, details: { fieldPath: `${cmd.component}.${cmd.field}`, reason: 'override-not-found' } } };
  }
  const result = ctx.engine.removeSceneOverride(root, member, tok, cmd.field);
  if (!result.ok) return { ok: false, error: { code: 'SET_FAILED', hint: String(result.error), details: { fieldPath: `${cmd.component}.${cmd.field}`, reason: 'engine-scene-override-rejected' } } };
  return {
    ok: true,
    inverse: { kind: 'setSceneOverride', root: cmd.root, member: cmd.member, component: cmd.component, field: cmd.field, value: clone(existing.value) },
    created: [],
  };
}

// ── shared<T> front-door binder (M7 / AC-10, plan-strategy D-5) ──────────────
// A catalogued asset GUID string written into a shared<T> component field
// (AnimationPlayer.clips, MeshFilter.assetHandle, MeshRenderer.materials, …) must
// be resolved to a live handle BEFORE the engine sees it. The engine's M2 P3 gate
// now REJECTS a raw GUID string in a shared<T> field (`shared-field-invalid-value`)
// instead of silently coercing it to handle 0, so the editor front door
// (addComponent / setComponent) resolves here first — mirroring the drag-spawn
// resolver (drag-spawn-resolve.ts) + preview closure (host-session.ts) spine, but
// synchronous so it runs inside the sync document applier.
//
// It is GENERAL (§2.5 — depend on the field's declared shape, not a per-asset-kind
// switch): the shared<T> target tag is derived from the component's own
// `resolveComponent(comp).schema[field]` keyword (`shared<X>` scalar or
// `array<shared<X>, N>` element), so one step closes material / clip / any future
// shared<T> field with zero new ops (no bindAnimationClip fan-out).
//
// Mixed-value boundary (plan-strategy D-8): only STRING elements are resolved;
// NUMBER elements are already-live handles and pass through untouched.

/** Extract the shared<T> target tag from a schema field keyword, or null if the
 *  field is not a shared reference. Handles both the scalar form `shared<X>` and
 *  the managed-array form `array<shared<X>, N>` / `array<shared<X>>`. */
function sharedTargetOf(fieldType: string): string | null {
  const scalar = /^shared<([^<>]+)>$/.exec(fieldType);
  if (scalar) return scalar[1] ?? null;
  const arr = /^array<shared<([^<>]+)>(?:\s*,\s*\d+)?>$/.exec(fieldType);
  if (arr) return arr[1] ?? null;
  return null;
}

/** Resolve any GUID-string values inside a component data/patch object's
 *  shared<T> fields into live handles. Returns a NEW object with the resolved
 *  values (untouched fields copied by reference); a resolve miss on any GUID
 *  aborts with a structured error so the caller fails fast (never a silent
 *  handle-0). Non-shared fields and numeric (already-live) handle values pass
 *  through unchanged. When the component has no shared fields — or the value
 *  carries no GUID strings — the original object is returned as-is. */
function resolveSharedFieldGuids(
  engine: EngineWriteProxy,
  componentName: string,
  value: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; hint: string } {
  const tok = resolveComponent(componentName) as { schema?: Record<string, string> } | undefined;
  const schema = tok?.schema;
  if (!schema) return { ok: true, value };

  let out: Record<string, unknown> | null = null; // lazily cloned on first change
  for (const [field, fieldValue] of Object.entries(value)) {
    const fieldType = schema[field];
    if (typeof fieldType !== 'string') continue;
    const target = sharedTargetOf(fieldType);
    if (target === null) continue;

    if (Array.isArray(fieldValue)) {
      // array<shared<T>>: resolve string elements, pass numbers through.
      let changed = false;
      const resolvedArr: unknown[] = fieldValue.map((el) => {
        if (typeof el !== 'string') return el;
        if (!el) { changed = true; return 0; } // empty string → null handle
        const r = engine.resolveSharedGuid(target, el);
        if (!r.ok) throw new SharedResolveMiss(`could not resolve GUID for ${componentName}.${field}[]: ${r.error.hint}`);
        changed = true;
        return r.value;
      });
      if (changed) {
        out ??= { ...value };
        out[field] = resolvedArr;
      }
    } else if (typeof fieldValue === 'string') {
      // Empty string = no asset assigned → null handle (0). Skip resolution.
      if (!fieldValue) {
        out ??= { ...value };
        out[field] = 0;
        continue;
      }
      // scalar shared<T>: resolve the single GUID.
      const r = engine.resolveSharedGuid(target, fieldValue);
      if (!r.ok) return { ok: false, hint: `could not resolve GUID for ${componentName}.${field}: ${r.error.hint}` };
      out ??= { ...value };
      out[field] = r.value;
    }
  }
  return { ok: true, value: out ?? value };
}

/** Sentinel thrown by the array-resolve arm so a mid-array miss unwinds to a
 *  single structured caller error (Array.map cannot early-return a Result). */
class SharedResolveMiss extends Error {}

/** Run the shared-field resolve, translating the array-arm sentinel into the
 *  uniform structured-error shape the callers consume. */
function resolveSharedFields(
  engine: EngineWriteProxy,
  componentName: string,
  value: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; hint: string } {
  try {
    return resolveSharedFieldGuids(engine, componentName, value);
  } catch (e) {
    if (e instanceof SharedResolveMiss) return { ok: false, hint: e.message };
    throw e;
  }
}

// ── addComponent applier ──────────────────────────────────────────────────────

export function applyAddComponent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  if (engine.get(eH, tok).ok) return { ok: false, error: { code: 'COMPONENT_EXISTS', hint: `component ${cmd.component} already on entity ${cmd.entity}` } };
  if (cmd.value !== undefined && (typeof cmd.value !== 'object' || cmd.value === null || Array.isArray(cmd.value))) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: `addComponent requires an object "value" field (got ${cmd.value === null ? 'null' : Array.isArray(cmd.value) ? 'array' : typeof cmd.value})` } };
  }
  const inputValue = Object.fromEntries(
    Object.entries((cmd.value ?? {}) as Record<string, unknown>)
      .filter(([, value]) => value !== undefined),
  );
  const completed = completeGroupedArrays(cmd.component, inputValue, undefined);
  if (!completed.ok) return { ok: false, error: { code: 'ADD_FAILED', hint: completed.hint, details: completed.details } };
  const validation = validateComponentWrite(cmd.component, completed.values, undefined, 'ADD_FAILED');
  if (!validation.ok) return { ok: false, error: { code: 'ADD_FAILED', hint: validation.hint, details: validation.details } };
  // Front-door shared<T> binder (M7 / AC-10): resolve any catalogued GUID strings
  // in shared fields to live handles before the engine sees them (Fail Fast on a
  // resolve miss — never pass the string through to the P3 gate / a silent 0).
  const resolved = resolveSharedFields(engine, cmd.component, completed.values);
  if (!resolved.ok) return { ok: false, error: { code: 'ADD_FAILED', hint: resolved.hint } };
  const r = engine.addComponent(eH, { component: tok, data: resolved.value as never });
  if (!r.ok) return { ok: false, error: { code: 'ADD_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'removeComponent', entity: cmd.entity, component: cmd.component }, created: [] };
}

// ── removeComponent applier ───────────────────────────────────────────────────

export function applyRemoveComponent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  // Name is intrinsic: removeComponent Name → PROTECTED_COMPONENT. Guard before
  // token resolution.
  if (cmd.component === 'Name') return { ok: false, error: { code: 'PROTECTED_COMPONENT', hint: 'Name is intrinsic and cannot be removed' } };
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const cur = engine.get(eH, tok);
  if (!cur.ok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.entity}` } };
  const value = clone(cur.value);
  const r = engine.removeComponent(eH, tok);
  if (!r.ok) return { ok: false, error: { code: 'REMOVE_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'addComponent', entity: cmd.entity, component: cmd.component, value }, created: [] };
}

// ── setVisibility applier ─────────────────────────────────────────────────────
// Visibility.state is the single authored intent. The engine render extractor
// resolves parent inheritance and filters render candidates; the editor must not
// mirror effective state onto descendants with Disabled or a second marker.

function visibilityStateFromValue(value: unknown): VisibilityState | undefined {
  return visibilityStateFromU32(Number(value));
}

export function applySetVisibility(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as Extract<EditorOp, { kind: 'setVisibility' }>;
  const { engine, alias } = ctx;
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  if (cmd.state !== 'inherited' && cmd.state !== 'hidden' && cmd.state !== 'visible') {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: `invalid Visibility state "${String(cmd.state)}"` } };
  }

  const current = engine.get(eH, Visibility);
  const previous = current.ok
    ? visibilityStateFromValue((current.value as { state: number }).state)
    : 'inherited';
  if (previous === undefined) {
    return { ok: false, error: { code: 'SET_FAILED', hint: `entity ${cmd.entity} has an invalid Visibility state` } };
  }

  if (cmd.state === 'inherited') {
    if (current.ok) {
      const r = engine.removeComponent(eH, Visibility);
      if (!r.ok) return { ok: false, error: { code: 'SET_FAILED', hint: String(r.error) } };
      return {
        ok: true,
        inverse: { kind: 'addComponent', entity: cmd.entity, component: 'Visibility', value: clone(current.value) },
        created: [],
      };
    }
    return { ok: true, inverse: { kind: 'setVisibility', entity: cmd.entity, state: 'inherited' }, created: [] };
  }

  const value = { state: VisibilityStateValue[cmd.state] };
  if (current.ok) {
    const r = engine.set(eH, Visibility, value);
    if (!r.ok) return { ok: false, error: { code: 'SET_FAILED', hint: String(r.error) } };
    return {
      ok: true,
      inverse: previous === 'inherited'
        ? { kind: 'setComponent', entity: cmd.entity, component: 'Visibility', patch: clone(current.value) }
        : { kind: 'setVisibility', entity: cmd.entity, state: previous },
      created: [],
    };
  }

  const r = engine.addComponent(eH, { component: Visibility, data: value });
  if (!r.ok) return { ok: false, error: { code: 'SET_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'removeComponent', entity: cmd.entity, component: 'Visibility' }, created: [] };
}

// ── transaction applier ───────────────────────────────────────────────────────

export function applyTransaction(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  if (cmd.commands.length === 0) return { ok: false, error: { code: 'EMPTY_TRANSACTION', hint: 'transaction has no commands' } };
  const inverses: EditorOp[] = [];
  // Flatten every sub-op's created roots into one array (D-2: top-level created =
  // all sub-ops' roots). A caller needing per-sub-op roots (e.g. spawnClipboard's
  // "primary root of each paste") reads each sub-op's own dispatch result instead.
  const created: EntityHandle[] = [];
  for (const sub of cmd.commands) {
    const r = ctx.dispatchSub(ctx, sub);
    if (!r.ok) {
      for (let i = inverses.length - 1; i >= 0; i--) ctx.dispatchSub(ctx, inverses[i]!);
      return r;
    }
    inverses.push(r.inverse);
    created.push(...r.created);
  }
  inverses.reverse();
  return { ok: true, inverse: { kind: 'transaction', label: `undo ${cmd.label}`, commands: inverses }, created };
}

// ── instantiateSceneAsset applier ─────────────────────────────────────────────
// Re-instantiate a collected SceneAsset POD (produced OUT of this applier by
// EditGateway.collectSceneAsset, the one read-side collection seam) as live world
// entities. This is the ONE document op both "copy an existing entity" paths
// project onto — duplicateEntity (Ctrl+D) and clipboard
// paste — so material fidelity (materials round-trip by GUID) and subtree survival
// come from the engine's own round-trip, not a hand-rolled component copy that
// dropped the source MeshRenderer (the fixed bug).
//
// invariant 7: the raw allocSharedRef + registry.instantiateFlat live inside
// EngineFacade.instantiateSceneAssetFlat (the sole raw-world file); this applier
// only calls that facade method + facade set/addComponent — never a raw world.

/**
 * Apply a prepared public duplicate. Gateway owns the source read and freezes the
 * collected POD on the command before this document applier runs; this body only
 * projects that POD onto the established instantiateSceneAsset write path.
 */
export function applyDuplicateEntity(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as Extract<EditorOp, { kind: 'duplicateEntity' }>;
  if (cmd._asset === undefined) {
    return {
      ok: false,
      error: {
        code: 'SCENE_COLLECT_FAILED',
        hint: 'duplicateEntity requires a Gateway-collected SceneAsset; dispatch through EditGateway',
      },
    };
  }
  const instantiate: EditorOp = {
    kind: 'instantiateSceneAsset',
    asset: cmd._asset,
    parent: cmd.parent,
    name: cmd.name,
    posOffset: cmd.posOffset,
    label: cmd.label,
  };
  // Delegate to the instantiate applier; its result already carries `created`
  // (the new roots), so duplicate forwards it verbatim.
  return applyInstantiateSceneAsset(ctx, instantiate);
}

export function applyInstantiateSceneAsset(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const asset = cmd.asset as SceneAsset | undefined;
  if (!asset) return { ok: false, error: { code: 'INVALID_ARGS', hint: 'instantiateSceneAsset requires a collected `asset` (SceneAsset POD)' } };

  const r = engine.instantiateSceneAssetFlat(asset);
  if (!r.ok) {
    // instantiateSceneAssetFlat returns AssetError | PackError | EcsError |
    // {NO_REGISTRY} — all opaque here; surface as a single structured code so the
    // failure never flows downstream silently (Fail Fast / charter P3).
    return { ok: false, error: { code: 'INSTANTIATE_FAILED', hint: `scene-asset instantiate failed: ${JSON.stringify(r.error)}` } };
  }
  const newRoots = r.value as EntityHandle[];
  if (newRoots.length === 0) {
    return { ok: false, error: { code: 'INSTANTIATE_FAILED', hint: 'scene-asset instantiate produced no roots' } };
  }

  // Retarget the PRIMARY root: parent + name. rootsToSceneAsset strips ChildOf on
  // roots (they collect parentless), so a parent must be re-attached via ChildOf
  // addComponent — the same relationship-hook path applyReparent uses so the
  // Children mirror stays in sync.
  const primary = newRoots[0]!;
  if (cmd.parent !== undefined && cmd.parent !== null) {
    const parentEng = toEntity(alias, cmd.parent);
    if (engine.get(parentEng, Name).ok) {
      const pr = engine.addComponent(primary, { component: ChildOf, data: { parent: parentEng } });
      if (!pr.ok) return cascadeInstantiateFailure(engine, newRoots, 'REPARENT_FAILED', String(pr.error));
    }
  }
  if (typeof cmd.name === 'string') {
    const nr = engine.set(primary, Name, { value: cmd.name });
    if (!nr.ok) return cascadeInstantiateFailure(engine, newRoots, 'RENAME_FAILED', String(nr.error));
  }

  // Positional offset (paste): shift every new root's Transform.pos so a paste
  // lands beside the source rather than exactly on top of it.
  if (Array.isArray(cmd.posOffset)) {
    const [dx, dy, dz] = cmd.posOffset as [number, number, number];
    for (const root of newRoots) {
      const tr = engine.get(root, Transform);
      if (!tr.ok) continue;
      const cur = ((tr.value as unknown as { pos?: ArrayLike<number> }).pos) ?? [0, 0, 0];
      engine.set(root, Transform, { pos: [(cur[0] ?? 0) + (dx ?? 0), (cur[1] ?? 0) + (dy ?? 0), (cur[2] ?? 0) + (dz ?? 0)] } as Parameters<typeof engine.set>[2]);
    }
  }

  // Inverse: destroy every new root. destroyEntity cascades the subtree
  // (applyDestroyEntity), so one op per root restores the pre-instantiate state.
  const destroys: EditorOp[] = newRoots.map((e) => ({ kind: 'destroyEntity' as const, entity: e }));
  const label = typeof cmd.label === 'string' ? cmd.label : 'instantiate';
  return {
    ok: true,
    inverse: destroys.length === 1 ? destroys[0]! : { kind: 'transaction', label: `undo ${label}`, commands: destroys },
    // The new roots are the created channel (replaces the old cmd._newRoots
    // in-place rewrite, which JSON couldn't carry back over the eval bridge).
    created: newRoots,
  };
}

/** Best-effort rollback when a post-instantiate retarget step fails: despawn the
 *  already-spawned roots so a half-built duplicate never survives (Fail Fast). */
function cascadeInstantiateFailure(
  engine: EngineWriteProxy,
  roots: EntityHandle[],
  code: CommandError['code'],
  hint: string,
): ApplyResult {
  for (const root of roots) engine.despawn(root);
  return { ok: false, error: { code, hint } };
}

// ── applyCommand dispatch ───────────────────────────────────────────────────

/** Dispatch a single document op through the ctx-based appliers. Shared by both
 *  the public `applyCommand` wrapper and (via ctx.dispatchSub) transaction sub-op
 *  recursion. NO span push/pop here — the caller decides span policy. */
function applyCommandCtx(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  switch (cmd.kind) {
    case 'spawnEntity':
      return applySpawnEntity(ctx, cmd);
    case 'destroyEntity':
      return applyDestroyEntity(ctx, cmd);
    case 'rename':
      return applyRename(ctx, cmd);
    case 'reparent':
      return applyReparent(ctx, cmd);
    case 'setComponent':
      return applySetComponent(ctx, cmd);
    case 'setSceneOverride':
      return applySetSceneOverride(ctx, cmd);
    case 'removeSceneOverride':
      return applyRemoveSceneOverride(ctx, cmd);
    case 'addComponent':
      return applyAddComponent(ctx, cmd);
    case 'removeComponent':
      return applyRemoveComponent(ctx, cmd);
    case 'setVisibility':
      return applySetVisibility(ctx, cmd);
    case 'instantiateSceneAsset':
      return applyInstantiateSceneAsset(ctx, cmd);
    case 'duplicateEntity':
      return applyDuplicateEntity(ctx, cmd);
    case 'transaction':
      return applyTransaction(ctx, cmd);
    // A non-document kind reaching here means the gateway routed a session/
    // transient op into the document applier — a wiring bug; fail fast.
    default:
      return { ok: false, error: { code: 'UNKNOWN_OP', hint: `applyCommand handles document ops only; "${(cmd as { kind: string }).kind}" is a session/transient op` } };
  }
}

/** Build a DocApplierCtx from a session (engine facade over session.world +
 *  fresh transaction alias + non-span-pushing dispatchSub). Compat path used by
 *  the public `applyCommand(session, cmd)` entry (begin/update/commit/undo/redo
 *  and the index.ts export). The gateway's executor builds its OWN ctx (cached
 *  facade + span-pushing dispatchSub) — both produce the same DocApplierCtx shape.
 *  The alias map is created fresh here so a transaction's forward-references
 *  resolve; it is discarded when this ctx goes out of scope. */
export function buildDocCtxForSession(session: EditSession): DocApplierCtx {
  // Pass session.registry so this compat-path facade can also run the scene-asset
  // round-trip (instantiateSceneAssetFlat needs the registry for GUID→handle
  // resolution). This path drives undo/redo (gateway.undo/redo → applyCommand),
  // so an instantiateSceneAsset REDO would fail here without the registry — same
  // wiring the gateway executor's _getEngineFacade does with doc.registry.
  const engine = new EngineFacade(session.world as World, session.registry) as unknown as EngineWriteProxy;
  const alias: DocAliasMap = new Map();
  const ctx: DocApplierCtx = {
    engine,
    // Asset write gate (north-star §2 axis symmetry): begin/undo of destroyAsset
    // reach pack IO through this, consistent with the gateway executor ctx. The
    // shared `assetIO` singleton is intentional (AC-D2): its per-path pack write
    // chains serialize RMW writes across every consumer of the gate.
    assetIO,
    alias,
    // Non-span-pushing recursion reusing the SAME ctx (so the transaction alias
    // threads through every sub-op — forward-references resolve).
    dispatchSub: (c, sub) => applyCommandCtx(c, sub),
    query: () => ({ ok: false, error: { code: 'QUERY_UNAVAILABLE', hint: 'query snapshot is only wired on the gateway executor ctx' } }),
  };
  return ctx;
}

/**
 * Apply a document op against a session (public/compat entry). Builds a
 * DocApplierCtx internally (with a fresh transaction alias) and dispatches
 * through the ctx-based appliers — so the 9 appliers never receive an EditSession
 * or a raw world (D-2).
 */
export function applyCommand(session: EditSession, cmd: EditorOp): ApplyResult {
  return applyCommandCtx(buildDocCtxForSession(session), cmd);
}

// ── Hierarchy helpers (activeWorld walk, handle identity) ───────────────────
// childrenOf reads a World's Children (SSOT). Root entities = live entities with
// no live ChildOf parent (worldRootHandles). No legacy-map iteration, no dedup guard —
// the engine Children mirror after the transient fix writes each entry once
// (AC-11 Half A gone; Half B 'Children' kept out of spawnComponentData).

export function childrenOf(world: World, parent: EntityHandle | null): EntityHandle[] {
  // Cross-game realm gap: doc.world may be briefly undefined — empty tree, no throw.
  if (world == null) return [];
  if (parent !== null) {
    const ch = world.get(parent, Children);
    if (ch.ok) {
      const val = ch.value as { entities: number[] | Uint32Array };
      const raw = val.entities;
      const arr: number[] = Array.isArray(raw) ? raw : Array.from(raw as Uint32Array);
      return arr.map((eH: number) => eH as EntityHandle);
    }
    return [];
  }
  // Root entities: live entities with no live ChildOf parent.
  return worldRootHandles(world);
}

export function isSelfOrDescendant(world: World, node: EntityHandle, candidate: EntityHandle): boolean {
  if (node === candidate) return true;
  for (const c of childrenOf(world, node)) {
    if (isSelfOrDescendant(world, c, candidate)) return true;
  }
  return false;
}
