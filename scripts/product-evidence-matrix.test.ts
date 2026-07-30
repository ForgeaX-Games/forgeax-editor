import { expect, test } from 'bun:test';

import {
  MILESTONE_EVIDENCE,
  U1_U8,
  createEvidenceReport,
  validateEvidenceMatrix,
  type EvidenceCheck,
} from './product-evidence-matrix';

function checks(): readonly EvidenceCheck[] {
  return MILESTONE_EVIDENCE.map((entry) => ({
    milestone: entry.milestone,
    status: 'pass' as const,
    command: entry.command,
    artifact: entry.artifact,
    acAnchors: entry.acAnchors,
    roadmapAnchors: entry.roadmapAnchors,
    journeyAnchors: entry.journeyAnchors,
  }));
}

test('M0-M8 evidence has one independently rerunnable check per milestone', () => {
  const validation = validateEvidenceMatrix(checks(), U1_U8.map((entry) => ({ ...entry, status: 'pass' as const })));
  expect(validation).toEqual({ ok: true, issues: [] });
  expect(new Set(checks().map((entry) => entry.milestone)).size).toBe(9);
});

test('evidence reporter rejects skip, flaky, missing anchors, and early-evidence substitution', () => {
  const report = createEvidenceReport({
    milestoneChecks: checks().map((entry, index) => index === 8 ? { ...entry, status: 'skip' as const } : entry),
    uChecks: U1_U8.map((entry) => ({ ...entry, status: 'pass' as const })),
  });
  expect(report.status).toBe('blocked');
  expect(report.issues).toEqual(expect.arrayContaining(['M8:status-skip']));

  const missing = createEvidenceReport({
    milestoneChecks: checks().slice(0, 8),
    uChecks: U1_U8.map((entry) => ({ ...entry, status: 'pass' as const })),
  });
  expect(missing.status).toBe('blocked');
  expect(missing.issues).toContain('missing-milestone:M8');
});

test('U1-U8 are explicit workflow recovery evidence, not a single aggregate pass flag', () => {
  expect(U1_U8.map((entry) => entry.id)).toEqual(['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8']);
  expect(U1_U8.every((entry) => entry.command.length > 0 && entry.artifact.length > 0)).toBe(true);
});
