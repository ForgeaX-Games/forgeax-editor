// Derived run index. It is rebuilt from journal records and owns no history.

import type { OperationRun } from '../contracts/run';

export class RunIndex {
  private readonly entries = new Map<string, OperationRun>();

  static fromRuns(runs: readonly OperationRun[]): RunIndex {
    const index = new RunIndex();
    for (const run of runs) index.set(run);
    return index;
  }

  set(run: OperationRun): void {
    this.entries.set(run.runId, run);
  }

  get(runId: string): OperationRun | undefined {
    return this.entries.get(runId);
  }

  delete(runId: string): void {
    this.entries.delete(runId);
  }

  values(): readonly OperationRun[] {
    return Object.freeze([...this.entries.values()]);
  }

  has(runId: string): boolean {
    return this.entries.has(runId);
  }

  clear(): void {
    this.entries.clear();
  }
}
