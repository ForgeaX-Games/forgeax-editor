import { applyCommand, createEditSession } from './document';
import type { CommandError, EditorCommand, EditSession } from './types';

export type BusListener = (doc: EditSession, lastCommand: EditorCommand | null) => void;

export type DispatchResult =
  | { ok: true }
  | { ok: false; error: CommandError };

/** Who issued a command — human UI action vs AI tool-call. */
export type CommandOrigin = 'human' | 'ai';

interface StackEntry {
  cmd: EditorCommand;
  inverse: EditorCommand;
  origin: CommandOrigin;
}

/** One timeline step for the History panel. */
export interface HistoryStep {
  label: string;
  origin: CommandOrigin;
  /** true if this step is currently undone (a redoable "future" step). */
  future: boolean;
  /** the entity this command operated on, if any (for selection sync). */
  entity?: number;
}

function labelOf(cmd: EditorCommand): string {
  return cmd.kind + ('component' in cmd ? ` ${(cmd as { component: string }).component}` : '');
}

function entityOf(cmd: EditorCommand): number | undefined {
  return 'entity' in cmd ? (cmd as { entity: number }).entity : undefined;
}

function step(label: string, origin: CommandOrigin, future: boolean, entity: number | undefined): HistoryStep {
  return entity === undefined ? { label, origin, future } : { label, origin, future, entity };
}

/**
 * The single authoritative mutable path. Human UI and AI both call `dispatch`.
 * Maintains Undo/Redo stacks (each entry = the command + its inverse) and
 * notifies subscribers after every change. Selection is intentionally NOT a
 * command here — it is transient view state (see selection store).
 */
export class EditorBus {
  doc: EditSession;
  private undoStack: StackEntry[] = [];
  private redoStack: StackEntry[] = [];
  private listeners = new Set<BusListener>();
  // Monotonic revision — bumped on EVERY mutation that notifies subscribers
  // (dispatch/undo/redo via emit, and replaceDoc). Lets consumers (e.g. the
  // engine sync) detect "did the doc change since I last looked?" in O(1) instead
  // of hashing the whole document. Every path that fires subscribers bumps this,
  // so a subscriber that only ever runs on notification can trust rev as a
  // complete change signal.
  private _rev = 0;
  get rev(): number { return this._rev; }
  /** append-only log of every applied command — the "AI did X" ledger. */
  readonly ledger: EditorCommand[] = [];
  /** origin of each ledger entry (index-aligned): who issued the command. */
  readonly origins: CommandOrigin[] = [];

  constructor(doc: EditSession = createEditSession()) {
    this.doc = doc;
  }

  dispatch(cmd: EditorCommand, origin: CommandOrigin = 'human'): DispatchResult {
    const r = applyCommand(this.doc, cmd);
    if (!r.ok) return r;
    this.undoStack.push({ cmd, inverse: r.inverse, origin });
    this.redoStack.length = 0;
    this.ledger.push(cmd);
    this.origins.push(origin);
    this.emit(cmd);
    return { ok: true };
  }

  /** Swap in a new authored session (scene load). Clears history — old
   * inverses target the previous session and must not be replayed. */
  replaceDoc(doc: EditSession): void {
    this.doc = doc;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.ledger.length = 0;
    this.origins.length = 0;
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, null);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const r = applyCommand(this.doc, entry.inverse);
    if (!r.ok) {
      // should not happen; restore stack and bail
      this.undoStack.push(entry);
      return false;
    }
    this.redoStack.push({ cmd: entry.cmd, inverse: r.inverse, origin: entry.origin });
    this.emit(entry.inverse);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const r = applyCommand(this.doc, entry.cmd);
    if (!r.ok) {
      this.redoStack.push(entry);
      return false;
    }
    this.undoStack.push({ cmd: entry.cmd, inverse: r.inverse, origin: entry.origin });
    this.emit(entry.cmd);
    return true;
  }

  /** Number of currently-applied steps (the history "head" position). */
  appliedCount(): number {
    return this.undoStack.length;
  }

  /** Full timeline (applied steps oldest→newest, then redoable future steps). */
  historySteps(): HistoryStep[] {
    const applied = this.undoStack.map((e) => step(labelOf(e.cmd), e.origin, false, entityOf(e.cmd)));
    const future = [...this.redoStack].reverse().map((e) => step(labelOf(e.cmd), e.origin, true, entityOf(e.cmd)));
    return [...applied, ...future];
  }

  /** Move the timeline head to exactly `target` applied steps (undo/redo as needed). */
  jumpTo(target: number): void {
    while (this.undoStack.length > target && this.undo()) {
      /* undo down */
    }
    while (this.undoStack.length < target && this.redo()) {
      /* redo up */
    }
  }

  subscribe(fn: BusListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(last: EditorCommand): void {
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, last);
  }
}
