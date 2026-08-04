// regression-manifest.ts — the product-owned R3-07 regression contract.
//
// One manifest describes the checks that `bun fx ci` can execute. The same
// coordinates are printed in the human route line and written to the optional
// JSON report, so a red command can be located without translating a generic
// shell step back into a roadmap. Commands remain ordinary Bun/Playwright
// entry points; this file owns selection and provenance, not their semantics.

export type RegressionProfile = 'fast' | 'full';
export type FixtureLayer = 'R0' | 'R1' | 'R2';

export interface RegressionCheck {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly fixtureLayer: FixtureLayer;
  readonly roadmapId: string;
  readonly journey: string;
  readonly gate: string;
  readonly profiles: readonly RegressionProfile[];
}

const fast: readonly RegressionProfile[] = ['fast', 'full'];
const full: readonly RegressionProfile[] = ['full'];

export const REGRESSION_MANIFEST_VERSION = 'forgeax-regression/v1';

export const REGRESSION_CHECKS: readonly RegressionCheck[] = Object.freeze([
  {
    id: 'r0-platform-io-unit',
    name: 'platform-io unit tests',
    command: 'bun',
    args: ['-F', '@forgeax/platform-io', 'test'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J0/J1',
    gate: 'C4/C6/C7',
    profiles: fast,
  },
  {
    id: 'r0-material-pack-shape',
    name: 'material pack shape',
    command: 'bun',
    args: ['scripts/validate-material-pack-shape.mjs'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J0',
    gate: 'C4/C5/C6',
    profiles: fast,
  },
  {
    id: 'r0-standalone-b2',
    name: 'standalone B2 self-boot',
    command: 'bun',
    args: ['scripts/selfcheck-standalone-b2.mjs'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J0',
    gate: 'C4/C5/C6',
    profiles: fast,
  },
  {
    id: 'r0-editor-lint',
    name: 'editor lint',
    command: 'bun',
    args: ['run', 'lint'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J0/J1',
    gate: 'C2/C3',
    profiles: fast,
  },
  {
    id: 'r0-dependency-cycle-lint',
    name: 'dependency-cycle lint',
    command: 'bun',
    args: ['run', 'lint:dep'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J0/J1',
    gate: 'C7',
    profiles: fast,
  },
  {
    id: 'r0-editor-typecheck',
    name: 'editor typecheck',
    command: 'bun',
    args: ['run', 'typecheck'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J0/J1',
    gate: 'C2/C3/C7',
    profiles: fast,
  },
  {
    id: 'r0-core-unit',
    name: 'editor-core unit tests',
    command: 'bun',
    args: ['-F', '@forgeax/editor-core', 'test'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J0/J1',
    gate: 'C2/C4/C6',
    profiles: fast,
  },
  {
    id: 'r0-product-unit',
    name: 'editor-product unit tests',
    command: 'bun',
    args: ['-F', '@forgeax/editor-product', 'test'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J0',
    gate: 'C1/C3/C6',
    profiles: fast,
  },
  {
    id: 'r0-panels-unit',
    name: 'editor-panels unit tests',
    command: 'bun',
    args: ['-F', '@forgeax/editor-panels', 'test'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J0/J1',
    gate: 'C3',
    profiles: fast,
  },
  {
    id: 'r0-edit-runtime-unit',
    name: 'edit-runtime unit tests',
    command: 'bun',
    args: ['-F', '@forgeax/editor-edit-runtime', 'test'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J0/J1',
    gate: 'C5/C6',
    profiles: fast,
  },
  {
    id: 'r0-content-browser-unit',
    name: 'content-browser unit tests',
    command: 'bun',
    args: ['-F', '@forgeax/editor-content-browser', 'test'],
    fixtureLayer: 'R0',
    roadmapId: 'R0-08',
    journey: 'J1',
    gate: 'C1/C3/C4',
    profiles: fast,
  },
  {
    id: 'r1-true-fixture',
    name: 'R1 true multi-scene fixture',
    command: 'bun',
    args: ['run', 'test:e2e', 'e2e/true-fixture.spec.ts'],
    fixtureLayer: 'R1',
    roadmapId: 'R1-08',
    journey: 'J2/J3',
    gate: 'C4/C5/C6/C7',
    profiles: full,
  },
  {
    id: 'r1-placement-binding',
    name: 'R1 placement and binding regression',
    command: 'bun',
    args: ['run', 'test:e2e', 'e2e/placement-binding-regression.spec.ts'],
    fixtureLayer: 'R1',
    roadmapId: 'R1-08',
    journey: 'J2/J3',
    gate: 'C4/C5/C6/C7',
    profiles: full,
  },
  {
    id: 'r1-play-stop-world-fork',
    name: 'R1 Play/Stop world fork regression',
    command: 'bun',
    args: ['run', 'test:e2e', 'e2e/play-stop-world-fork.spec.ts'],
    fixtureLayer: 'R1',
    roadmapId: 'R1-08',
    journey: 'J2/J3',
    gate: 'C5/C6/C7',
    profiles: full,
  },
  {
    id: 'r2-j5-static-artifact',
    name: 'R2 J5 validation + static artifact smoke',
    command: 'bun',
    args: ['run', 'test:j5'],
    fixtureLayer: 'R2',
    roadmapId: 'R2-06',
    journey: 'J5',
    gate: 'C1/C4/C5/C6/C7',
    profiles: full,
  },
  {
    id: 'r2-j4-interaction-release',
    name: 'R2 J4 interaction and release smoke',
    command: 'bun',
    args: [
      'run',
      'test:e2e',
      'e2e/j4-runner.spec.ts',
      'e2e/smoke-boot-play.spec.ts',
      'e2e/smoke-content-browser.spec.ts',
      'e2e/save-operation-run.spec.ts',
      'e2e/play-real-game-safety-net.spec.ts',
    ],
    fixtureLayer: 'R2',
    roadmapId: 'R2-06',
    journey: 'J4/J0/J1',
    gate: 'C4/C5/C6/C7',
    profiles: full,
  },
]);

export function selectRegressionChecks(
  profile: RegressionProfile,
  fixtureLayer?: FixtureLayer,
): readonly RegressionCheck[] {
  return REGRESSION_CHECKS.filter((check) =>
    check.profiles.includes(profile) && (fixtureLayer === undefined || check.fixtureLayer === fixtureLayer),
  );
}

export function parseFixtureLayer(value: string | undefined): FixtureLayer | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toUpperCase();
  if (normalized === 'R0' || normalized === 'R1' || normalized === 'R2') return normalized;
  throw new Error(`unknown fixture layer '${value}'; expected R0, R1, or R2`);
}
