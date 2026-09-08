import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

test('maintained Editor sources use the canonical product and transport vocabulary', () => {
  const retiredProductShell = ['work', 'bench'].join('');
  const retiredTransportName = ['host', 'SDK'].join('');
  const retiredTransportPackage = ['host', '[-_ ]?s', 'dk'].join('');
  const result = spawnSync('git', [
    'grep', '-n', '-i', '-E',
    `${retiredProductShell}|${retiredTransportPackage}|${retiredTransportName}|\\bL[0-9]\\b`,
    '--',
    ':!packages/play-runtime/src/__tests__/carrier-handshake.test.ts',
    ':!scripts/__tests__/selfcheck-standalone-b2.test.mjs',
  ], { encoding: 'utf8' });

  expect([0, 1]).toContain(result.status);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('');
});
