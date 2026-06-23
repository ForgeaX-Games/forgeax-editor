// @forgeax/engine-ecs — DAG Schedule: Kahn topological sort + cycle detection.
//
// addSystem registers a system + marks dirty. First update() triggers buildSchedule().
// Same in-degree systems ordered by addSystem call order (stable tie-breaker, D-05).

import { err, ok, type Result } from '@forgeax/engine-types';
import type { ArchetypeGraph } from './archetype-graph';
import type { CommandBuffer } from './commands';
import type { Component } from './component';
import { CyclicDependencyError, ScheduleMutationError } from './errors';
import type { ColumnBundle, NestedColumnBundle, QueryDescriptor, QueryState } from './query';
import { createQueryState, queryRun } from './query';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Severity + ErrorHandler (Layer 3 — AP-8)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Seven-level severity enum for error classification (AP-8 Layer 3).
 * Default is `Panic` (KD-2: fail-fast by default).
 * Ordered: Ignore < Trace < Debug < Info < Warning < Error < Panic.
 */
export const Severity = {
  Ignore: 0,
  Trace: 1,
  Debug: 2,
  Info: 3,
  Warning: 4,
  Error: 5,
  Panic: 6,
} as const;

export type SeverityLevel = (typeof Severity)[keyof typeof Severity];

/**
 * Error context passed to the ErrorHandler along with the error.
 */
export interface ErrorContext {
  /** Severity level of the error (default: Panic). */
  readonly severity: SeverityLevel;
  /** Name of the system that produced the error. */
  readonly systemName: string;
}

/**
 * ErrorHandler function signature. Called when a system returns a Result err
 * branch (`r.ok === false`) or ParamValidation returns 'invalid'.
 */
export type ErrorHandler = (error: unknown, context: ErrorContext) => void;

/**
 * Default error handler: dispatches by severity level.
 * Panic → throw, Error → console.error, Warning → console.warn,
 * Info → console.info, Debug/Trace → console.debug, Ignore → silent.
 */
export function matchSeverity(error: unknown, context: ErrorContext): void {
  switch (context.severity) {
    case Severity.Panic:
      throw error;
    case Severity.Error:
      console.error(`[${context.systemName}]`, error);
      break;
    case Severity.Warning:
      console.warn(`[${context.systemName}]`, error);
      break;
    case Severity.Info:
      // biome-ignore lint/suspicious/noConsole: matchSeverity routes errors to console by design
      console.info(`[${context.systemName}]`, error);
      break;
    case Severity.Debug:
    case Severity.Trace:
      // biome-ignore lint/suspicious/noConsole: matchSeverity routes errors to console by design
      console.debug(`[${context.systemName}]`, error);
      break;
    case Severity.Ignore:
      // Silent — do nothing
      break;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ParamValidation (Layer 2 — AP-8)
// ────────────────────────────────────────────────────────────────────────────

/**
 * ParamValidation three-state result for system parameter validation (AP-8 Layer 2).
 *
 * - `ok`: all params valid, system body executes.
 * - `skipped`: expected absence (e.g. query no match), body NOT executed, schedule continues.
 * - `invalid`: unexpected absence (e.g. Resource missing), body NOT executed, error collected.
 */
export type ParamValidation =
  | { readonly tag: 'ok' }
  | { readonly tag: 'skipped'; readonly reason: string }
  | { readonly tag: 'invalid'; readonly error: Error };

/**
 * System descriptor passed to `world.addSystem` — `fn` recovers per-query
 * bundle shapes mapped over `Qs`, no `as` casts required.
 *
 * `Qs` is the tuple of query descriptors; defaults to
 * `readonly QueryDescriptor[]` so non-generic call sites stay zero-modification
 * (KD-5). The `fn` first parameter is mapped over `Qs` so each
 * `queryResults[i]` recovers its own `NestedColumnBundle<Qs[i]['with']>` shape
 * (S-5, KD-2). `NoInfer<Qs[K]['with']>` blocks the callback body from feeding
 * back into `Qs` inference.
 *
 * @example
 * ```ts
 * // Single-query system — bundle fields recover per-component schema.
 * import { defineComponent, World } from '@forgeax/engine-ecs';
 *
 * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
 * const Velocity = defineComponent('Velocity', { dx: 'f32', dy: 'f32' });
 *
 * const world = new World();
 * world.addSystem({
 *   name: 'movement',
 *   queries: [{ with: [Position, Velocity] }],
 *   fn: (queryResults, _commands) => {
 *     for (const bundles of queryResults[0]) {
 *       // bundles.Position.x: Float32Array — directly usable, no `as` cast.
 *       const xs = bundles.Position.x;
 *       const dxs = bundles.Velocity.dx;
 *       for (let i = 0; i < bundles.Entity.self.length; i++) {
 *         // strict `noUncheckedIndexedAccess`: TypedArray index returns number | undefined
 *         xs[i] = (xs[i] ?? 0) + (dxs[i] ?? 0);
 *       }
 *     }
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Multi-query system — each queryResults[i] keeps its own bundle shape.
 * const Health = defineComponent('Health', { hp: 'f32' });
 * world.addSystem({
 *   name: 'multi',
 *   queries: [{ with: [Position] }, { with: [Health] }],
 *   fn: (queryResults) => {
 *     // queryResults[0]: NestedColumnBundle<readonly [typeof Position]>[]
 *     // queryResults[1]: NestedColumnBundle<readonly [typeof Health]>[]
 *     for (const b of queryResults[0]) void b.Position.x;
 *     for (const b of queryResults[1]) void b.Health.hp;
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Commands-only system — `queries: []` is a legal form; fn receives `[]`.
 * world.addSystem({
 *   name: 'spawner',
 *   queries: [],
 *   fn: (_queryResults, commands) => {
 *     commands.spawn({ component: Position, data: { x: 0, y: 0 } });
 *   },
 * });
 * ```
 */
export interface SystemDescriptor<
  Qs extends ReadonlyArray<QueryDescriptor> = ReadonlyArray<QueryDescriptor>,
> {
  /** Unique system name (used for before/after references). */
  readonly name: string;
  /** Query descriptors this system reads. */
  readonly queries: Qs;
  /**
   * System function — receives resolved query results + commands.
   *
   * @param queryResults Mapped over `Qs`: `queryResults[i][j]` is a
   * `NestedColumnBundle<Qs[i]['with']>` with per-component TypedArray fields.
   * Direct access (`bundles.Position.x`) compiles without `as` casts.
   * @param commands Deferred-mutation buffer (flushed after the system).
   */
  readonly fn: (
    queryResults: {
      [K in keyof Qs]: Qs[K] extends QueryDescriptor<infer Cs extends ReadonlyArray<Component>>
        ? NestedColumnBundle<NoInfer<Cs>>[]
        : ColumnBundle[];
    },
    commands: CommandBuffer,
  ) => void | unknown;
  /** Run this system after the named systems. */
  readonly after?: ReadonlyArray<string>;
  /** Run this system before the named systems. */
  readonly before?: ReadonlyArray<string>;
  /** Required resource keys. Missing resource triggers 'invalid' validation (Layer 2). */
  readonly resources?: ReadonlyArray<string>;
}

/** Internal system record with registration index. */
interface SystemRecord {
  descriptor: SystemDescriptor;
  /** Registration order index (for tie-breaking). */
  registrationIndex: number;
  /** Cached QueryStates, one per query descriptor. Lazily initialized on first runSchedule. */
  queryStates: QueryState[] | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Schedule
// ────────────────────────────────────────────────────────────────────────────

/** The Schedule manages system registration, DAG sorting, and execution. */
export interface Schedule {
  /** All registered systems by name. */
  systems: Map<string, SystemRecord>;
  /** Next registration index. */
  nextIndex: number;
  /** Whether the sorted order is stale. */
  dirty: boolean;
  /** Sorted system names after buildSchedule(). */
  sortedOrder: string[];
}

/** Create a fresh Schedule. */
export function createSchedule(): Schedule {
  return {
    systems: new Map(),
    nextIndex: 0,
    dirty: true,
    sortedOrder: [],
  };
}

/**
 * Register a system. Marks schedule as dirty.
 * Query states are lazily initialized on first runSchedule (needs World for O-3 per-World ID).
 *
 * `const Qs` locks the `queries` tuple at the call site so `fn`'s first
 * parameter recovers per-query bundle shapes without `as const` annotations
 * (S-5, KD-2). `SystemRecord` itself is intentionally non-generic — the
 * heterogeneous `Qs` cannot be expressed inside the systems Map (KD-3).
 */
export function addSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  schedule: Schedule,
  descriptor: SystemDescriptor<Qs>,
): void {
  const record: SystemRecord = {
    descriptor: descriptor as SystemDescriptor,
    registrationIndex: schedule.nextIndex++,
    queryStates: null, // Deferred: created in runSchedule when World is available
  };
  schedule.systems.set(descriptor.name, record);
  schedule.dirty = true;
}

/**
 * Remove a registered system by name (M2 — plan-strategy D-3).
 *
 * Drops the entry from `schedule.systems` and marks the schedule dirty so the
 * next `runSchedule` rebuilds the sorted order via Kahn topo. Cycle detection
 * already happens inside `buildSchedule`, so a removal that breaks an unrelated
 * `before/after` reference simply skips the unknown name (existing behaviour).
 *
 * Failure: name not registered → `Result.err(ScheduleMutationError)` with
 * `.code = 'system-before-unknown'` and `.detail.candidates` carrying the
 * registered names for AI-friendly typo recovery.
 */
export function removeSystem(
  schedule: Schedule,
  name: string,
): Result<void, ScheduleMutationError> {
  if (!schedule.systems.has(name)) {
    return err(
      new ScheduleMutationError(
        'system-before-unknown',
        `Cannot removeSystem: no system registered as "${name}".`,
        'Call world.inspect().systems to discover registered names.',
        { candidates: [...schedule.systems.keys()] },
      ),
    );
  }
  schedule.systems.delete(name);
  schedule.dirty = true;
  return ok(undefined);
}

/**
 * Replace a registered system in-place (M2 — plan-strategy D-3 atomic semantics).
 *
 * Overwrites the `descriptor` field of the existing `SystemRecord` while
 * keeping `registrationIndex` and the `Map` slot identical, so all `before /
 * after` edges that reference this name remain bound to the same slot. Marks
 * the schedule dirty: the next `runSchedule` re-sorts.
 *
 * Failure: name not registered → `Result.err(ScheduleMutationError)` with
 * `.code = 'system-before-unknown'`.
 */
export function replaceSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  schedule: Schedule,
  name: string,
  descriptor: SystemDescriptor<Qs>,
): Result<void, ScheduleMutationError> {
  const record = schedule.systems.get(name);
  if (!record) {
    return err(
      new ScheduleMutationError(
        'system-before-unknown',
        `Cannot replaceSystem: no system registered as "${name}".`,
        'Call world.inspect().systems to discover registered names; or addSystem(descriptor) to register a new system.',
        { candidates: [...schedule.systems.keys()] },
      ),
    );
  }
  record.descriptor = descriptor as SystemDescriptor;
  // Reset cached query states — descriptor.queries may have changed shape.
  record.queryStates = null;
  schedule.dirty = true;
  return ok(undefined);
}

/**
 * Build the sorted execution order via Kahn's topological sort.
 * Throws CyclicDependencyError if a cycle is detected.
 *
 * @returns sorted system names
 */
export function buildSchedule(schedule: Schedule): string[] {
  const systems = schedule.systems;
  const names = [...systems.keys()];
  const nameSet = new Set(names);

  // Build adjacency list + in-degree map.
  const adj = new Map<string, string[]>(); // adj[a] = [b] means a → b (a must run before b)
  const inDegree = new Map<string, number>();

  for (const name of names) {
    adj.set(name, []);
    inDegree.set(name, 0);
  }

  for (const [name, record] of systems) {
    const desc = record.descriptor;

    // "after" constraints: for each dep in after, dep → name (dep runs before name)
    if (desc.after) {
      for (const dep of desc.after) {
        if (!nameSet.has(dep)) continue; // skip unknown systems
        adj.get(dep)?.push(name);
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      }
    }

    // "before" constraints: for each target in before, name → target (name runs before target)
    if (desc.before) {
      for (const target of desc.before) {
        if (!nameSet.has(target)) continue; // skip unknown systems
        adj.get(name)?.push(target);
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm with registration-order tie-breaker.
  // Use a queue sorted by registrationIndex for deterministic ordering.
  const queue: string[] = [];
  for (const name of names) {
    if (inDegree.get(name) === 0) {
      queue.push(name);
    }
  }
  // Sort initial queue by registration index
  // biome-ignore lint/style/noNonNullAssertion: all names in queue are guaranteed to exist in systems map
  queue.sort((a, b) => systems.get(a)!.registrationIndex - systems.get(b)!.registrationIndex);

  const sorted: string[] = [];
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: while(queue.length > 0) guarantees shift() returns a value
    const current = queue.shift()!;
    sorted.push(current);

    const neighbors = adj.get(current) ?? [];
    // Collect newly freed neighbors, then sort by registration index
    const freed: string[] = [];
    for (const neighbor of neighbors) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        freed.push(neighbor);
      }
    }
    // biome-ignore lint/style/noNonNullAssertion: all names in freed are guaranteed to exist in systems map
    freed.sort((a, b) => systems.get(a)!.registrationIndex - systems.get(b)!.registrationIndex);
    queue.push(...freed);
  }

  // Cycle detection: if we didn't process all nodes, there's a cycle.
  if (sorted.length < names.length) {
    // Find nodes still with in-degree > 0 (part of cycle).
    const remaining = names.filter((n) => !sorted.includes(n));
    const cyclePath = findCyclePath(remaining, adj);
    throw new CyclicDependencyError(cyclePath);
  }

  schedule.sortedOrder = sorted;
  schedule.dirty = false;
  return sorted;
}

/**
 * Find a cycle path string among the remaining (unprocessed) nodes.
 */
function findCyclePath(remaining: string[], adj: Map<string, string[]>): string {
  const remainSet = new Set(remaining);
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string | null {
    if (visited.has(node)) {
      // Found cycle: extract cycle from path
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart);
      cycle.push(node);
      return cycle.join(' -> ');
    }
    visited.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (!remainSet.has(neighbor)) continue;
      const result = dfs(neighbor);
      if (result) return result;
    }

    path.pop();
    return null;
  }

  for (const start of remaining) {
    visited.clear();
    path.length = 0;
    const result = dfs(start);
    if (result) return result;
  }

  /* istanbul ignore next -- fallback: DFS always finds cycle in remaining nodes */
  return remaining.join(' -> ');
}

/** Interface for resource existence check (injected from World). */
export interface ResourceChecker {
  hasResource(key: string): boolean;
}

/**
 * Execute all systems in sorted order. Rebuilds schedule if dirty.
 * Each system receives its query results and a command buffer.
 * The world parameter provides the archetype graph, component ID resolution,
 * and resource checks.
 *
 * Layer 2 (ParamValidation): query empty → skip, resource missing → invalid.
 * Layer 3 (ErrorHandler): system fn returning a Result err branch → error handler.
 */
export function runSchedule(
  schedule: Schedule,
  world: { _getGraph(): ArchetypeGraph } & ResourceChecker,
  commands: CommandBuffer,
  errorHandler?: ErrorHandler,
): void {
  if (schedule.dirty) {
    buildSchedule(schedule);
  }

  for (const name of schedule.sortedOrder) {
    const record = schedule.systems.get(name);
    /* istanbul ignore next -- defensive: sortedOrder comes from systems Map keys */
    if (!record) continue;

    // Lazily initialize query states on first run (O-3: needs World for ID resolution).
    if (record.queryStates === null) {
      record.queryStates = record.descriptor.queries.map((q) => createQueryState(q));
    }

    // ── Layer 2: ParamValidation ──
    const validation = validateSystemParams(record, world);
    /* istanbul ignore next -- skipped path reserved for future Populated/Single query types */
    if (validation.tag === 'skipped') {
      // Expected absence — skip system body silently, continue to next system
      continue;
    }
    if (validation.tag === 'invalid') {
      // Unexpected absence — collect error via ErrorHandler
      if (errorHandler) {
        errorHandler(validation.error, {
          severity: Severity.Panic,
          systemName: name,
        });
      }
      continue;
    }

    // Run each query and collect results
    const queryResults: ColumnBundle[][] = [];
    for (const qs of record.queryStates) {
      const bundles: ColumnBundle[] = [];
      queryRun(qs, world, (bundle) => bundles.push(bundle));
      queryResults.push(bundles);
    }

    // ── Layer 3: system execution + Result collection ──
    // trusted-cast: F-R2 single-direction; runtime correctness guaranteed by buildColumnBundle
    const returnValue = record.descriptor.fn(
      queryResults as Parameters<typeof record.descriptor.fn>[0],
      commands,
    );

    // If system fn returns a Result with err, invoke ErrorHandler
    if (returnValue && typeof returnValue === 'object' && 'ok' in (returnValue as object)) {
      const result = returnValue as { ok: boolean; error?: unknown };
      if (result.ok === false && result.error !== undefined) {
        if (errorHandler) {
          errorHandler(result.error, {
            severity: Severity.Panic,
            systemName: name,
          });
        }
      }
    }
    // void return → treated as ok, ErrorHandler not called
  }
}

/**
 * Validate system parameters before execution (Layer 2).
 * - Query empty match → ok (Bevy: Query is always Ok; skip is for Populated/Single — not yet in forgeax).
 * - All required resources must exist; otherwise → invalid.
 *
 * Note: "query empty → skipped" path is available via the ParamValidation type
 * but not auto-triggered for plain queries. Future extensions (Populated, Single)
 * will use the skipped path.
 */
function validateSystemParams(record: SystemRecord, world: ResourceChecker): ParamValidation {
  // Check required resources
  if (record.descriptor.resources) {
    for (const key of record.descriptor.resources) {
      if (!world.hasResource(key)) {
        return {
          tag: 'invalid',
          error: new Error(
            `Required resource "${key}" not found for system "${record.descriptor.name}".`,
          ),
        };
      }
    }
  }

  return { tag: 'ok' };
}
