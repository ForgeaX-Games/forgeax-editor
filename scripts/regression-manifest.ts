// regression-manifest.ts — the product-owned projection of the CI contract.
//
// The contract is the only business roster. This module keeps the historical
// forgeax-regression/v1 execution shape for downstream callers while deriving
// every check identity, profile, owner, and execution home from that producer
// source of truth.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RegressionProfile = 'fast' | 'full';
export type FixtureLayer = 'R0' | 'R1' | 'R2';

export interface ContractCheck {
  readonly checkId: string;
  readonly owner: string;
  readonly command: string;
  readonly executionHome: Readonly<Record<string, boolean>>;
}

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
  readonly owner: string;
  readonly executionHome: Readonly<Record<string, boolean>>;
}

export interface RegressionManifestProjection {
  readonly manifestVersion: typeof REGRESSION_MANIFEST_VERSION;
  readonly checks: readonly RegressionCheck[];
  readonly profiles: Readonly<Record<RegressionProfile, readonly string[]>>;
  readonly requiredContexts: readonly { readonly context: string; readonly checkId: string }[];
}

interface ContractDocument {
  readonly version: string;
  readonly checks: readonly ContractCheck[];
  readonly profiles: Readonly<Record<string, readonly string[]>>;
  readonly requiredContexts: readonly { readonly context: string; readonly checkId: string }[];
}

export const REGRESSION_MANIFEST_VERSION = 'forgeax-regression/v1';

const profileNames: Readonly<Record<RegressionProfile, string>> = {
  fast: 'local-fast',
  full: 'local-full',
};

const contractPath = resolve(
  fileURLToPath(new URL('../ci/editor-ci-contract.json', import.meta.url)),
);

function loadContract(): ContractDocument {
  return JSON.parse(readFileSync(contractPath, 'utf8')) as ContractDocument;
}

function splitCommand(command: string): readonly [string, ...string[]] {
  const parts = command.trim().split(/\s+/);
  const executable = parts.shift();
  if (!executable) throw new Error('contract check command must not be empty');
  return [executable, ...parts];
}

function profilesFor(checkId: string, contract: ContractDocument): readonly RegressionProfile[] {
  return (['fast', 'full'] as const).filter((profile) =>
    contract.profiles[profileNames[profile]]?.includes(checkId),
  );
}

function projectCheck(check: ContractCheck, contract: ContractDocument): RegressionCheck {
  const [command, ...args] = splitCommand(check.command);
  return {
    id: check.checkId,
    name: check.checkId,
    command,
    args,
    fixtureLayer: 'R0',
    roadmapId: 'R3-07',
    journey: 'J0/J1',
    gate: 'C1-C7',
    profiles: profilesFor(check.checkId, contract),
    owner: check.owner,
    executionHome: structuredClone(check.executionHome),
  };
}

export function projectRegressionManifest(input: ContractDocument): RegressionManifestProjection {
  const checks = input.checks.map((check) => projectCheck(check, input));
  return {
    manifestVersion: REGRESSION_MANIFEST_VERSION,
    checks,
    profiles: {
      fast: [...(input.profiles['local-fast'] ?? [])],
      full: [...(input.profiles['local-full'] ?? [])],
    },
    requiredContexts: input.requiredContexts.map(({ context, checkId }) => ({ context, checkId })),
  };
}

const CONTRACT = loadContract();

export const REGRESSION_CONTRACT_VERSION = CONTRACT.version;
export const REGRESSION_MANIFEST = projectRegressionManifest(CONTRACT);
export const REGRESSION_CHECKS: readonly RegressionCheck[] = Object.freeze(REGRESSION_MANIFEST.checks);

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
