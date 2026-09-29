// Opt-in trace for Hierarchy eye / visibility (localStorage or global flag).
//   localStorage.setItem('forgeax:trace:hierarchy-visibility', '1'); location.reload()

const STORAGE_KEY = 'forgeax:trace:hierarchy-visibility';

export function isHierarchyVisibilityTraceEnabled(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const host = globalThis as typeof globalThis & {
    __FORGEAX_TRACE_HIER_VISIBILITY?: boolean;
  };
  if (host.__FORGEAX_TRACE_HIER_VISIBILITY === true) return true;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function traceHierarchyVisibility(
  phase: string,
  detail: Record<string, unknown> = {},
): void {
  if (!isHierarchyVisibilityTraceEnabled()) return;
  console.info('[forgeax:hier-vis]', {
    ts: typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now(),
    phase,
    ...detail,
  });
}

export function traceVisibilityCommandKind(command: unknown): string | undefined {
  if (command === null || typeof command !== 'object') return undefined;
  const kind = (command as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
}

export function isVisibilityRelatedCommandKind(kind: string | undefined): boolean {
  return kind === 'setVisibility' || kind === 'hierarchyGesture';
}

/** Document commands that change effective Visibility (incl. transaction sub-ops). */
export function isVisibilityDocumentCommand(command: unknown): boolean {
  if (command === null || typeof command !== 'object') return false;
  const record = command as { kind?: unknown; action?: unknown; commands?: unknown };
  if (record.kind === 'setVisibility') return true;
  if (record.kind === 'hierarchyGesture' && record.action === 'visibility') return true;
  if (record.kind === 'transaction' && Array.isArray(record.commands)) {
    return record.commands.some(isVisibilityDocumentCommand);
  }
  return false;
}

export type VisibilityCommandState = 'hidden' | 'inherited' | 'visible';

export function extractVisibilityCommandState(command: unknown): VisibilityCommandState | null {
  if (command === null || typeof command !== 'object') return null;
  const record = command as { kind?: unknown; action?: unknown; state?: unknown; commands?: unknown };
  if (record.kind === 'setVisibility' && typeof record.state === 'string') {
    return record.state as VisibilityCommandState;
  }
  if (record.kind === 'hierarchyGesture' && record.action === 'visibility' && typeof record.state === 'string') {
    return record.state as VisibilityCommandState;
  }
  if (record.kind === 'transaction' && Array.isArray(record.commands)) {
    for (let i = record.commands.length - 1; i >= 0; i -= 1) {
      const state = extractVisibilityCommandState(record.commands[i]);
      if (state !== null) return state;
    }
  }
  return null;
}

export function extractVisibilityCommandEntityIds(command: unknown): number[] {
  if (command === null || typeof command !== 'object') return [];
  const record = command as {
    kind?: unknown;
    action?: unknown;
    entity?: unknown;
    entities?: unknown;
    commands?: unknown;
  };
  if (record.kind === 'setVisibility' && typeof record.entity === 'number') {
    return [record.entity];
  }
  if (record.kind === 'hierarchyGesture' && record.action === 'visibility' && Array.isArray(record.entities)) {
    return record.entities.filter((id): id is number => typeof id === 'number');
  }
  if (record.kind === 'transaction' && Array.isArray(record.commands)) {
    const ids: number[] = [];
    for (const sub of record.commands) ids.push(...extractVisibilityCommandEntityIds(sub));
    return ids;
  }
  return [];
}

export function isVisibilityHierarchyGesture(operation: {
  readonly kind: string;
  readonly action?: unknown;
}): boolean {
  return operation.kind === 'setVisibility'
    || (operation.kind === 'hierarchyGesture' && operation.action === 'visibility');
}
