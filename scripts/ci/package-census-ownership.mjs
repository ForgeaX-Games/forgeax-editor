export const OWNERSHIP_CLASSES = [
  'Editor-owned',
  'consumed-submodule-contract',
  'intentionally non-tested host',
];

function error(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function ok(value) {
  return { ok: true, ...value };
}

function fail(code, expected, observed, hint) {
  return { ok: false, error: error(code, expected, observed, hint) };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCommandList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.trim());
}

function validateCoverage(packageJson) {
  const coverage = packageJson.forgeaxCi?.quality?.coverage;
  if (!isObject(coverage)) return fail('quality-obligation-missing', 'quality.coverage with lines and functions floors', coverage ?? 'missing', 'Declare forgeaxCi.quality.coverage for every Editor-owned test-bearing package.');
  if (typeof coverage.lines !== 'number') return fail('quality-lines-floor-missing', 'numeric quality.coverage.lines floor', coverage.lines ?? 'missing', 'Add a numeric lines floor between 0 and 100.');
  if (typeof coverage.functions !== 'number') return fail('quality-functions-floor-missing', 'numeric quality.coverage.functions floor', coverage.functions ?? 'missing', 'Add a numeric functions floor between 0 and 100.');
  if (![coverage.lines, coverage.functions].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) {
    return fail('quality-floor-out-of-range', 'lines and functions floors between 0 and 100', coverage, 'Set both coverage floors to finite values in the inclusive 0-100 range.');
  }
  return ok();
}

export function validatePackageQuality(packageJson, testFiles = []) {
  if (!isObject(packageJson)) return fail('quality-package-invalid', 'package manifest object', packageJson, 'Provide a readable package.json object.');
  const metadata = packageJson.forgeaxCi;
  const ownership = metadata?.ownership;
  if (ownership === 'intentionally non-tested host') {
    const obligations = metadata.obligations;
    if (!isObject(obligations) || !['static', 'integration'].includes(obligations.kind) || !validCommandList(obligations.checks)) {
      return fail('host-obligation-missing', 'static or integration obligation with executable checks', obligations ?? 'missing', 'Declare forgeaxCi.obligations.kind and a non-empty checks list for the host.');
    }
    if (metadata.quality !== undefined) return fail('host-coverage-forbidden', 'host without package coverage producer metadata', metadata.quality, 'Remove coverage metadata from an intentionally non-tested host.');
    return ok({ ownership });
  }
  if (ownership !== 'Editor-owned') return fail('quality-ownership-invalid', 'Editor-owned package', ownership ?? 'missing', 'Declare Editor-owned before adding package quality obligations.');
  if (typeof packageJson.scripts?.test !== 'string' || !packageJson.scripts.test.trim()) {
    return fail('quality-test-entry-missing', 'package scripts.test executable entry', packageJson.scripts?.test ?? 'missing', 'Add an executable test script before declaring package coverage.');
  }
  if (!isObject(metadata.quality) || typeof metadata.quality.test !== 'string' || !metadata.quality.test.trim()) {
    return fail('quality-obligation-missing', 'forgeaxCi.quality.test executable entry', metadata.quality ?? 'missing', 'Declare the package test command and its coverage floors.');
  }
  const coverageResult = validateCoverage(packageJson);
  if (!coverageResult.ok) return coverageResult;
  if (testFiles.length > 0 && metadata.quality.test.trim().length === 0) {
    return fail('quality-obligation-missing', 'test files have a declared test obligation', testFiles, 'Bind discovered test files to the package test entry.');
  }
  return ok({ ownership, quality: metadata.quality });
}

function declarationMap(input) {
  const declarations = input.ownershipDeclarations ?? [];
  const seen = new Set();
  for (const declaration of declarations) {
    if (!declaration || typeof declaration.path !== 'string') return fail('ownership-declaration-invalid', 'declaration with a path', declaration, 'Declare an ownership path for every override.');
    if (seen.has(declaration.path)) return fail('ownership-duplicate', 'one ownership declaration per surface', declaration.path, 'Remove the duplicate ownership declaration and keep one policy owner.');
    seen.add(declaration.path);
  }
  return ok({ declarations });
}

function declaredOwnership(surface, declarations) {
  const explicit = declarations.find((entry) => entry.path === surface.path)?.ownership;
  return explicit ?? surface.packageJson?.forgeaxCi?.ownership;
}

function classifySurface(surface, input, declarations) {
  const gitlink = surface.kind === 'gitlink-root' || typeof surface.gitlinkRoot === 'string';
  const declared = declaredOwnership(surface, declarations);
  if (gitlink) {
    if (declared && declared !== 'consumed-submodule-contract') return fail('gitlink-ownership-override', 'consumed-submodule-contract', declared, 'Keep gitlink roots and their nested packages under the submodule consumer contract.');
    return ok({ surface: { ...surface, ownership: 'consumed-submodule-contract', boundary: surface.gitlinkRoot ?? surface.path } });
  }
  if (input.strictDeclarations && !declared) return fail('ownership-missing', 'one explicit ownership declaration per surface', surface.path, 'Declare Editor-owned or intentionally non-tested host for this surface.');
  const ownership = declared ?? 'Editor-owned';
  if (!OWNERSHIP_CLASSES.includes(ownership)) return fail('ownership-unknown', OWNERSHIP_CLASSES, ownership, 'Use one of the three supported ownership classes; declare a supported ownership value.');
  if (ownership === 'intentionally non-tested host') {
    const qualityResult = validatePackageQuality(surface.packageJson, surface.testFiles ?? []);
    if (!qualityResult.ok) return qualityResult;
  }
  return ok({ surface: { ...surface, ownership } });
}

export function classifyOwnership(input) {
  if (!Array.isArray(input?.surfaces)) return { ok: false, errors: [error('ownership-input-invalid', 'census surfaces array', input?.surfaces ?? 'missing', 'Pass the structured census surfaces to the ownership classifier.')] };
  const uniquePaths = new Set();
  for (const surface of input.surfaces) {
    if (uniquePaths.has(surface.path)) return { ok: false, errors: [error('ownership-duplicate', 'one census surface per path', surface.path, 'Remove duplicate census surfaces before classification.')] };
    uniquePaths.add(surface.path);
  }
  const mapResult = declarationMap(input);
  if (!mapResult.ok) return { ok: false, errors: [mapResult.error] };
  const surfaces = [];
  for (const surface of input.surfaces) {
    const result = classifySurface(surface, input, mapResult.declarations);
    if (!result.ok) return { ok: false, errors: [result.error] };
    surfaces.push(result.surface);
  }
  return { ok: true, surfaces };
}
