import { expect, test } from 'bun:test';
import { bootDiagnostics } from '../boot-diagnostic';
import { VagCarrierFailureDetailSchema } from '@forgeax/editor-core/protocol';

test('diagnostics retain only bounded public producer facts through the carrier schema', () => {
  const diagnostic: any = { code: 'scan-failed', cause: [{ code: 'source-failed', detail: { sourcePath: './assets/scene.pack.ts', unusedDeclaredGuids: ['guid'], password: 'secret' }, stack: 'private' }] };
  diagnostic.cause.push(diagnostic);
  const diagnostics = bootDiagnostics(diagnostic);
  const wire = VagCarrierFailureDetailSchema.parse({ code: 'source-failed', hint: 'fix source', stage: 'handshake', retryable: false, at: 'now', diagnostics });
  expect(wire.diagnostics).toEqual([{ code: 'scan-failed' }, { code: 'source-failed', sourcePath: './assets/scene.pack.ts', unusedDeclaredGuids: ['guid'] }]);
  expect(JSON.stringify(wire)).not.toContain('secret');
  expect(JSON.stringify(wire)).not.toContain('private');
  expect(bootDiagnostics({ code: 'root', cause: Array.from({ length: 100 }, () => ({ code: 'child' })) })).toHaveLength(16);
});
