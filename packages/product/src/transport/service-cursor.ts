export interface CursorValue {
  readonly runId: string;
  readonly snapshotRevision: string;
  readonly sequence: number;
}

export function createEventCursor(value: CursorValue): string {
  return 'event:' + encodeURIComponent(JSON.stringify(value));
}

export function decodeEventCursor(value: string): CursorValue | null {
  if (!value.startsWith('event:')) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value.slice(6))) as Partial<CursorValue>;
    return typeof parsed.runId === 'string' && typeof parsed.snapshotRevision === 'string' && typeof parsed.sequence === 'number'
      ? { runId: parsed.runId, snapshotRevision: parsed.snapshotRevision, sequence: parsed.sequence }
      : null;
  } catch { return null; }
}
