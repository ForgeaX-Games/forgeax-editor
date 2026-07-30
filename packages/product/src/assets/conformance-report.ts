export interface AssetConformanceFailure {
  readonly scenarioId: string;
  readonly code: string;
  readonly hint: string;
}

export interface AssetConformanceScenario {
  readonly id: string;
  readonly title: string;
  readonly kind: 'lifecycle' | 'safety';
  readonly acAnchor: string;
  readonly fixtureAnchor: string;
  readonly recoveryActions: readonly string[];
}

export interface AssetConformanceFixtureIssue {
  readonly scenarioId: string;
  readonly field: 'id' | 'title' | 'kind' | 'acAnchor' | 'fixtureAnchor' | 'recoveryActions';
  readonly code: 'duplicate-scenario-id' | 'missing-field' | 'invalid-scenario-id';
}

export interface AssetConformanceFixtureValidation {
  readonly ok: boolean;
  readonly issues: readonly AssetConformanceFixtureIssue[];
}

const expectedScenarioIds = [
  ...Array.from({ length: 63 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, index) => `H${String(index + 1).padStart(2, '0')}`),
];

function missingScenarioField(
  scenario: AssetConformanceScenario,
): 'id' | 'title' | 'kind' | 'acAnchor' | undefined {
  if (!scenario.id) return 'id';
  if (!scenario.title) return 'title';
  if (!scenario.kind) return 'kind';
  if (!scenario.acAnchor) return 'acAnchor';
  return undefined;
}

export function validateAssetConformanceFixtures(
  scenarios: readonly AssetConformanceScenario[],
): AssetConformanceFixtureValidation {
  const issues: AssetConformanceFixtureIssue[] = [];
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) {
      issues.push({ scenarioId: scenario.id, field: 'id', code: 'duplicate-scenario-id' });
    }
    seen.add(scenario.id);
    const field = missingScenarioField(scenario);
    if (field) {
      issues.push({ scenarioId: scenario.id, field, code: 'missing-field' });
    }
    if (!scenario.fixtureAnchor) {
      issues.push({ scenarioId: scenario.id, field: 'fixtureAnchor', code: 'missing-field' });
    }
    if (scenario.recoveryActions.length === 0) {
      issues.push({ scenarioId: scenario.id, field: 'recoveryActions', code: 'missing-field' });
    }
  }
  if (scenarios.length !== expectedScenarioIds.length) {
    issues.push({ scenarioId: 'fixture', field: 'id', code: 'invalid-scenario-id' });
  }
  for (const expectedId of expectedScenarioIds) {
    if (!seen.has(expectedId)) {
      issues.push({ scenarioId: expectedId, field: 'id', code: 'invalid-scenario-id' });
    }
  }
  return Object.freeze({ ok: issues.length === 0, issues: Object.freeze(issues) });
}

export interface AssetConformanceReport {
  readonly driver: 'public-product-adapter';
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly scenarioIds: readonly string[];
  readonly privateImports: readonly string[];
  readonly failures: readonly AssetConformanceFailure[];
}

export function createAssetConformanceReport(
  scenarioIds: readonly string[],
  failures: readonly AssetConformanceFailure[],
): AssetConformanceReport {
  return Object.freeze({
    driver: 'public-product-adapter' as const,
    total: scenarioIds.length,
    passed: scenarioIds.length - failures.length,
    failed: failures.length,
    scenarioIds: Object.freeze([...scenarioIds]),
    privateImports: Object.freeze([]),
    failures: Object.freeze([...failures]),
  });
}
