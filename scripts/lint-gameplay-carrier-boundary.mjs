#!/usr/bin/env node
// lint-gameplay-carrier-boundary.mjs — keep gameplay on the public carrier bridge.
//
// The broad __forgeax_editor global remains a non-gameplay editor diagnostics
// seam for existing editor E2E tests. Gameplay must not grow another private
// dispatch/capture transport on that object; Server-style page.evaluate logic
// belongs behind the versioned __forgeax_editor_gameplay bridge.

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = resolve(__dirname, '..');
const DEFAULT_SOURCE = resolve(EDITOR_ROOT, 'packages/edit-runtime/src/viewport/ViewportComponent.tsx');
const sourceArg = process.argv.indexOf('--file');
const source = sourceArg >= 0 ? process.argv[sourceArg + 1] : DEFAULT_SOURCE;

if (!source) {
  console.error('[lint-gameplay-carrier-boundary] --file requires a path');
  process.exit(2);
}

try {
  const body = readFileSync(resolve(source), 'utf8');
  const forbidden = [
    'dispatchGameplayInput',
    'dispatchGameplayQuery',
    'dispatchGameplayPlay',
    'dispatchGameplayStop',
    'captureGameplayFrame',
    'revealGameplayFrame',
  ];
  const violations = forbidden.filter((name) => body.includes(name));
  if (!body.includes('createGameplayCarrierBridge')) {
    violations.push('missing createGameplayCarrierBridge installation');
  }
  if (violations.length > 0) {
    console.error(`[lint-gameplay-carrier-boundary] VIOLATION in ${relative(EDITOR_ROOT, resolve(source))}:`);
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log('[lint-gameplay-carrier-boundary] OK — gameplay uses the public carrier bridge only.');
} catch (error) {
  console.error('[lint-gameplay-carrier-boundary] internal error:', error);
  process.exit(2);
}
