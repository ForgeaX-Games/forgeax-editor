// The migration census is intentionally explicit. Every row records the
// engine report and source that informed the decision, then names the editor
// invariant and one falsifier that would make the decision unsafe.

export const ENGINE_TECHNIQUE_MIGRATION = Object.freeze([
  {
    id: 'control-plane-graph',
    report: 'forgeax-engine/.forgeax-harness/solo/fast-robust-ci/experiments/20260723-005121-architecture-control-plane-audit-5/REPORT.md',
    source: 'forgeax-engine harness scripts/architecture-probe.mjs',
    decision: 'adapt',
    editorInvariant: 'The admitted workflow graph and live required contexts are emitted from one baseline packet.',
    semanticDelta: 'The editor has five CI jobs, Bun regression-manifest checks, and a GitHub ruleset; the engine census had a larger Bevy/Dawn graph and an artifact contract.',
    focusedFalsifier: 'Remove one live required job or mutate a needs, runner, or timeout field in a fixture; graph validation must fail before any run census is accepted.',
  },
  {
    id: 'attempt-aware-pagination',
    report: 'forgeax-engine/.forgeax-harness/solo/fast-robust-ci/experiments/20260723-171652-repair-slo-population-pagination-12/REPORT.md',
    source: 'forgeax-engine/scripts/ci/collect-ci-cost-facts.mjs and gh api --paginate --slurp',
    decision: 'reuse',
    editorInvariant: 'Every job packet carries the run attempt, preserves all REST pages, and rejects a zero or truncated packet.',
    semanticDelta: 'The editor reads /actions/runs/{id}/attempts/{attempt}/jobs and has no engine artifact payload; the packet integrity rule is shared.',
    focusedFalsifier: 'Drop a page or change one job run_attempt in a fixture; the packet validator must reject it with a pagination or attempt error.',
  },
  {
    id: 'comparable-critical-path',
    report: 'forgeax-engine/.forgeax-harness/solo/fast-robust-ci/experiments/20260723-003553-audit-comparable-main-slo-window/REPORT.md',
    source: 'forgeax-engine/scripts/ci/collect-ci-cost-facts.mjs',
    decision: 'adapt',
    editorInvariant: 'Comparable samples are terminal push-to-main runs with a stable job roster; queue, admission, active, and first-failure timings stay separate.',
    semanticDelta: 'The editor run has five required checks and runner-pool labels rather than the engine artifact-consumer roster.',
    focusedFalsifier: 'Mix a five-job packet with a packet containing an extra or missing job; stable-roster grouping must keep them out of one population.',
  },
  {
    id: 'live-ruleset-admission',
    report: 'forgeax-engine/.forgeax-harness/solo/fast-robust-ci/experiments/20260722-140409-audit-required-ruleset-admission-guard/REPORT.md',
    source: 'forgeax-engine/scripts/ci/audit-required-checks-ruleset.mjs and scripts/ci/required-ci-checks.json',
    decision: 'adapt',
    editorInvariant: 'The required context set is read from the active live ruleset and must map to an actual workflow job.',
    semanticDelta: 'The editor’s ruleset exposes four status contexts while the engine has a producer-owned required-check contract.',
    focusedFalsifier: 'Return an active ruleset with no required-status-check rule or an ambiguous context-to-job mapping; collection must stop closed-fail.',
  },
  {
    id: 'runner-pool-contract',
    report: 'forgeax-engine/.forgeax-harness/solo/fast-robust-ci/experiments/20260723-024741-audit-self-hosted-label-capacity-10/REPORT.md',
    source: 'forgeax-engine/scripts/ci/check-runner-pool-labels.mjs',
    decision: 'adapt',
    editorInvariant: 'Each self-hosted workflow job exposes exactly one explicit capacity pool in the graph.',
    semanticDelta: 'The editor already owns a smaller standard/heavy checker and must preserve the live labels without importing engine fleet assumptions.',
    focusedFalsifier: 'Replace one selector with self-hosted labels lacking standard/heavy or containing both; the graph parser and existing checker must reject it.',
  },
  {
    id: 'malformed-workflow-admission',
    report: 'forgeax-engine/.forgeax-harness/solo/fast-robust-ci/experiments/20260722-135208-audit-admission-malformed-workflow/REPORT.md',
    source: 'forgeax-engine/.github/workflows/required-ci-checks.yml admission parser; adapted in editor scripts/ci/check-workflow-admission.mjs',
    decision: 'adapt',
    editorInvariant: 'Every PR-head .github/workflows .yml or .yaml file is parsed from the trusted base before the existing admission checker or required-success path can proceed.',
    semanticDelta: 'The editor uses its dedicated runner-pool-contract carrier and a two-file workflow inventory; it preserves the existing runner-label checker and ruleset contract instead of copying the engine reporter roster.',
    focusedFalsifier: 'A YAML-valid fixture with needs: missing-job must be accepted by the generic YAML library but rejected by pinned actionlint; omitting .yaml enumeration or changing the immutable head checkout must fail the contract tests.',
  },
  {
    id: 'artifact-provenance',
    report: 'forgeax-engine/.forgeax-harness/solo/fast-robust-ci/experiments/20260721-180911-audit-shared-asset-transfer/REPORT.md',
    source: 'forgeax-engine/scripts/ci/verify-build-artifact-input.mjs and merge-provenance records',
    decision: 'defer',
    editorInvariant: 'No engine artifact-consumer timing or payload claim is projected onto editor CI.',
    semanticDelta: 'Editor baseline evidence is job-control-plane and check-timing only; its current five-job workflow has no shared engine artifact contract.',
    focusedFalsifier: 'Adding artifact upload/download to the editor workflow without a producer/consumer contract would invalidate this row and route to frc-04.',
  },
  {
    id: 'cache-roi',
    report: 'forgeax-engine/.forgeax-harness/solo/fast-robust-ci/experiments/20260720-141217-audit-cache-action-roi/REPORT.md',
    source: 'forgeax-engine/scripts/ci/check-ci-cost-budget.mjs and cache audit tooling',
    decision: 'defer',
    editorInvariant: 'Cache cost or hit-rate claims are not inferred from the editor’s local setup duration or cloud job packets.',
    semanticDelta: 'The editor task freezes a comparable CI baseline; cache optimization is a later frc-04/frc-08 decision with its own evidence.',
    focusedFalsifier: 'Treat a local engine-dist rebuild duration as a cloud cache ROI measurement; the evidence contract must reject that category error.',
  },
  {
    id: 'engine-fleet-roster',
    report: 'forgeax-engine/.forgeax-harness/solo/fast-robust-ci/experiments/20260721-165446-audit-smoke-fleet-contracts/REPORT.md',
    source: 'forgeax-engine/scripts/check-bevy-smoke-dependencies.mjs and Bevy/Dawn fleet workflow',
    decision: 'reject',
    editorInvariant: 'The editor baseline roster contains only editor-owned required contexts and does not inherit engine demo/fleet jobs.',
    semanticDelta: 'Engine Bevy/Dawn smoke coverage has no semantic equivalent in the standalone editor checkout.',
    focusedFalsifier: 'Copy an engine fleet job into the editor graph without an editor acceptance contract; roster validation must treat it as a mixed roster.',
  },
  {
    id: 'post-merge-observation',
    report: 'forgeax-engine/.forgeax-harness/solo/fast-robust-ci/experiments/20260723-220945-audit-post-merge-monitor-api-failure-64/REPORT.md',
    source: 'forgeax-engine/.github/workflows/post-merge-monitor.yml',
    decision: 'defer',
    editorInvariant: 'A merged-SHA reachability check is a shipping boundary in this round, not a new post-merge monitor workflow.',
    semanticDelta: 'The editor’s required checks and merge proof are captured by the current PR ship recipe; monitor ownership is frc-11.',
    focusedFalsifier: 'Declare an open PR or a local green run complete without a merged SHA reachable from remote main; the worker result must remain non-terminal.',
  },
]);

export function validateEngineTechniqueMigration(rows = ENGINE_TECHNIQUE_MIGRATION) {
  const decisions = new Set(['reuse', 'adapt', 'reject', 'defer']);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('engine migration matrix is empty');
  for (const row of rows) {
    for (const field of [
      'id',
      'report',
      'source',
      'decision',
      'editorInvariant',
      'semanticDelta',
      'focusedFalsifier',
    ]) {
      if (typeof row?.[field] !== 'string' || row[field].trim().length === 0) {
        throw new Error(`engine migration row ${row?.id ?? '<unknown>'} omits ${field}`);
      }
    }
    if (!decisions.has(row.decision)) throw new Error(`engine migration row ${row.id} has invalid decision`);
  }
  return rows;
}
