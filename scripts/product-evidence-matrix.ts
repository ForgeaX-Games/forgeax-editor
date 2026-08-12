// Auditable M0-M8 and U1-U8 evidence aggregation. The CLI executes the
// declared commands by default; library callers can still supply captured
// results. An unrun command is never turned into an implicit success.

import { resolve } from 'node:path';

export type MilestoneId = 'M0' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8';
export type EvidenceStatus = 'pass' | 'fail' | 'skip' | 'flaky';

export interface EvidenceDefinition {
  readonly milestone: MilestoneId;
  readonly command: string;
  readonly artifact: string;
  readonly acAnchors: readonly string[];
  readonly roadmapAnchors: readonly string[];
  readonly journeyAnchors: readonly string[];
}

export interface UEvidenceDefinition {
  readonly id: 'U1' | 'U2' | 'U3' | 'U4' | 'U5' | 'U6' | 'U7' | 'U8';
  readonly command: string;
  readonly artifact: string;
  readonly description: string;
}

export interface EvidenceCheck extends EvidenceDefinition {
  readonly status: EvidenceStatus;
  readonly output?: string;
}

export interface UEvidenceCheck extends UEvidenceDefinition {
  readonly status: EvidenceStatus;
  readonly output?: string;
}

export interface EvidenceMatrixInput {
  readonly milestoneChecks: readonly EvidenceCheck[];
  readonly uChecks: readonly UEvidenceCheck[];
}

export interface EvidenceValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export interface EvidenceReport extends EvidenceValidation {
  readonly status: 'pass' | 'blocked';
  readonly milestones: readonly EvidenceCheck[];
  readonly workflows: readonly UEvidenceCheck[];
  readonly commands: readonly string[];
  readonly skipCount: number;
  readonly flakyCount: number;
}

export const MILESTONE_EVIDENCE: readonly EvidenceDefinition[] = Object.freeze([
  { milestone: 'M0', command: 'bun run test:product-conformance', artifact: 'M0-wave1-compatibility.json', acAnchors: ['AC-01', 'AC-02', 'AC-26'], roadmapAnchors: ['M0'], journeyAnchors: ['discover'] },
  { milestone: 'M1', command: 'bun -F @forgeax/editor-product test', artifact: 'M1-capability-manifest.json', acAnchors: ['AC-03', 'AC-04', 'AC-06'], roadmapAnchors: ['M1'], journeyAnchors: ['discover', 'preflight'] },
  { milestone: 'M2', command: 'bun -F @forgeax/editor-product test', artifact: 'M2-operation-runs.json', acAnchors: ['AC-05', 'AC-06', 'AC-07', 'AC-08'], roadmapAnchors: ['M2'], journeyAnchors: ['dispatch', 'wait'] },
  { milestone: 'M3', command: 'bun -F @forgeax/editor-core test', artifact: 'M3-commit-collar.json', acAnchors: ['AC-09', 'AC-10', 'AC-18'], roadmapAnchors: ['M3'], journeyAnchors: ['save', 'undo', 'reopen'] },
  { milestone: 'M4', command: 'bun run test:product-conformance', artifact: 'M4-asset-workspace.json', acAnchors: ['AC-11', 'AC-12', 'AC-13'], roadmapAnchors: ['M4'], journeyAnchors: ['observe', 'reconcile'] },
  { milestone: 'M5', command: 'bun run test:product-conformance', artifact: 'M5-asset-lifecycle.json', acAnchors: ['AC-14', 'AC-15', 'AC-16', 'AC-17'], roadmapAnchors: ['M5'], journeyAnchors: ['preflight', 'mutate', 'restore'] },
  { milestone: 'M6', command: 'bun run test:e2e apps/standalone/e2e/__tests__/unified-editor-product.spec.ts apps/standalone/e2e/__tests__/operation-center.spec.ts', artifact: 'M6-shared-projection.json', acAnchors: ['AC-19', 'AC-20', 'AC-21'], roadmapAnchors: ['M6'], journeyAnchors: ['human-projection', 'query'] },
  { milestone: 'M7', command: 'bun run test:product-headless', artifact: 'M7-production-transport.json', acAnchors: ['AC-22', 'AC-23', 'AC-24'], roadmapAnchors: ['M7'], journeyAnchors: ['transport', 'play', 'stop'] },
  { milestone: 'M8', command: 'bun run test:product-conformance', artifact: 'M8-workflow-recovery.json', acAnchors: ['AC-02', 'AC-25', 'AC-26'], roadmapAnchors: ['M8'], journeyAnchors: ['workflow', 'restart-reconcile', 'recover'] },
]);

export const U1_U8: readonly UEvidenceDefinition[] = Object.freeze([
  { id: 'U1', command: 'bun test packages/product/src/kernel/__tests__/workflow-conformance.test.ts', artifact: 'U1-import-mount.json', description: 'Import and mount a scene asset.' },
  { id: 'U2', command: 'bun test packages/product/src/kernel/__tests__/workflow-roundtrip.test.ts', artifact: 'U2-material-roundtrip.json', description: 'Create and bind a material, save, reopen, and Play.' },
  { id: 'U3', command: 'bun test packages/product/src/kernel/__tests__/workflow-conformance.test.ts', artifact: 'U3-batch-move.json', description: 'Preflight and move a batch while preserving conflict facts.' },
  { id: 'U4', command: 'bun test packages/product/src/kernel/__tests__/workflow-policy.test.ts', artifact: 'U4-failure-recovery.json', description: 'Locate a child failure and expose recovery actions.' },
  { id: 'U5', command: 'bun test packages/product/src/kernel/__tests__/workflow-coordinator.test.ts', artifact: 'U5-idempotent-retry.json', description: 'Retry with a new attempt without repeating an equivalent effect.' },
  { id: 'U6', command: 'bun test packages/product/src/kernel/__tests__/workflow-restart-reconciliation.test.ts', artifact: 'U6-restart-reconcile.json', description: 'Reconcile detached runs after process restart.' },
  { id: 'U7', command: 'bun test packages/product/src/kernel/__tests__/run-journal-recovery.test.ts', artifact: 'U7-unknown-expired.json', description: 'Recover from unknown, expired, and malformed run records.' },
  { id: 'U8', command: 'bun run test:product-conformance', artifact: 'U8-evidence-report.json', description: 'Produce the final auditable evidence report.' },
]);

const MILESTONES: readonly MilestoneId[] = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'];
const WORKFLOWS = U1_U8.map((entry) => entry.id);

export function validateEvidenceMatrix(
  milestoneChecks: readonly EvidenceCheck[],
  uChecks: readonly UEvidenceCheck[],
): EvidenceValidation {
  const issues: string[] = [];
  const seenMilestones = new Set<string>();
  for (const check of milestoneChecks) {
    if (seenMilestones.has(check.milestone)) issues.push(`duplicate-milestone:${check.milestone}`);
    seenMilestones.add(check.milestone);
    if (check.status === 'skip') issues.push(`${check.milestone}:status-skip`);
    else if (check.status === 'flaky') issues.push(`${check.milestone}:status-flaky`);
    else if (check.status !== 'pass') issues.push(`${check.milestone}:status-${check.status}`);
    if (check.command.trim() === '') issues.push(`${check.milestone}:missing-command`);
    if (check.artifact.trim() === '') issues.push(`${check.milestone}:missing-artifact`);
    if (check.acAnchors.length === 0 || check.roadmapAnchors.length === 0 || check.journeyAnchors.length === 0) issues.push(`${check.milestone}:missing-anchor`);
    if (check.milestone === 'M8' && check.artifact.includes('R0')) issues.push('M8:early-evidence-substitution');
  }
  for (const milestone of MILESTONES) if (!seenMilestones.has(milestone)) issues.push(`missing-milestone:${milestone}`);
  const seenWorkflows = new Set<string>();
  for (const check of uChecks) {
    if (seenWorkflows.has(check.id)) issues.push(`duplicate-workflow:${check.id}`);
    seenWorkflows.add(check.id);
    if (check.status !== 'pass') issues.push(`${check.id}:status-${check.status}`);
    if (check.command.trim() === '') issues.push(`${check.id}:missing-command`);
    if (check.artifact.trim() === '') issues.push(`${check.id}:missing-artifact`);
  }
  for (const id of WORKFLOWS) if (!seenWorkflows.has(id)) issues.push(`missing-workflow:${id}`);
  return { ok: issues.length === 0, issues: Object.freeze(issues) };
}

export function createEvidenceReport(input: EvidenceMatrixInput): EvidenceReport {
  const validation = validateEvidenceMatrix(input.milestoneChecks, input.uChecks);
  const all = [...input.milestoneChecks, ...input.uChecks];
  return Object.freeze({
    ...validation,
    status: validation.ok ? 'pass' : 'blocked',
    milestones: Object.freeze([...input.milestoneChecks]),
    workflows: Object.freeze([...input.uChecks]),
    commands: Object.freeze([...new Set(all.map((entry) => entry.command))]),
    skipCount: all.filter((entry) => entry.status === 'skip').length,
    flakyCount: all.filter((entry) => entry.status === 'flaky').length,
  });
}

export function createExpectedEvidenceReport(): EvidenceReport {
  return createEvidenceReport({
    milestoneChecks: MILESTONE_EVIDENCE.map((entry) => ({ ...entry, status: 'fail' as const, output: 'not-run' })),
    uChecks: U1_U8.map((entry) => ({ ...entry, status: 'fail' as const, output: 'not-run' })),
  });
}

function commandArgs(command: string): string[] {
  return command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, '')) ?? [];
}

async function runCommand(command: string): Promise<{ readonly status: EvidenceStatus; readonly output: string }> {
  const args = commandArgs(command);
  if (args.length === 0) return { status: 'fail', output: 'empty command' };
  const timeoutMs = Number(process.env.FORGEAX_EVIDENCE_TIMEOUT_MS ?? 120_000);
  const child = Bun.spawn({ cmd: args, cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(timeoutMs) });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = [stdout, stderr].filter(Boolean).join('\n').slice(-12000);
  return { status: exitCode === 0 ? 'pass' : 'fail', output: output || `exit=${exitCode}` };
}

export async function executeEvidenceMatrix(): Promise<EvidenceReport> {
  const milestoneChecks = [] as EvidenceCheck[];
  for (const entry of MILESTONE_EVIDENCE) milestoneChecks.push({ ...entry, ...(await runCommand(entry.command)) });
  const uChecks = [] as UEvidenceCheck[];
  for (const entry of U1_U8) uChecks.push({ ...entry, ...(await runCommand(entry.command)) });
  return createEvidenceReport({ milestoneChecks, uChecks });
}

if (import.meta.main) {
  const report = process.argv.includes('--expected') ? createExpectedEvidenceReport() : await executeEvidenceMatrix();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
