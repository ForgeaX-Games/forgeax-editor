import { expect, test } from 'bun:test';

import { runProductStdioJourney } from './editor-product-stdio';

test('production stdio journey is UI-free and matches non-display product facts', async () => {
  const report = await runProductStdioJourney();

  expect(report).toMatchObject({
    ok: true,
    uiFree: true,
    usesChromium: false,
    usesRawEval: false,
    capabilityParity: true,
    runParity: true,
    assetParity: true,
    saveReopenParity: true,
    saveRequestId: expect.stringMatching(/^stdio-save-/),
    saveTerminalStatus: 'failed',
    saveRunParity: true,
    playParity: true,
  });
  expect(report.steps).toEqual([
    'discover', 'query', 'dispatch', 'wait', 'save', 'fresh-reopen', 'play', 'stop',
  ]);
});

test('stdio journey returns structured recovery data for a terminal failure', async () => {
  const report = await runProductStdioJourney({ failStep: 'play' });
  expect(report).toMatchObject({ ok: false, terminal: { status: 'failed' } });
  expect(report.terminal.error).toMatchObject({
    code: expect.any(String),
    retryable: expect.any(Boolean),
    recoveryActions: expect.any(Array),
  });
});
