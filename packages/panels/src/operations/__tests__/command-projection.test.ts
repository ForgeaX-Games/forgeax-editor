import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const operationCenterSource = readFileSync(resolve(import.meta.dir, '../OperationCenter.tsx'), 'utf8');
const runProjectionSource = readFileSync(resolve(import.meta.dir, '../run-view-model.ts'), 'utf8');
const gatewayProjectionSource = readFileSync(
  resolve(import.meta.dir, '../../../../edit-runtime/src/gateway-action-projection.ts'),
  'utf8',
);

describe('command projection boundary', () => {
  it('uses the shared product projection and recovery seam', () => {
    expect(operationCenterSource).toContain('getOperationProjectionSource');
    expect(operationCenterSource).toContain('source.dispatchRecovery');
    expect(operationCenterSource).not.toContain('gateway.dispatch');
    expect(operationCenterSource).not.toContain('useEffect');
    expect(operationCenterSource).toContain('const visibleRows = subscribedRows;');
    expect(operationCenterSource).not.toContain('readonly rows?:');
    expect(operationCenterSource).not.toContain('readonly revision?:');
    expect(runProjectionSource).toContain('recoveryActions');
    expect(runProjectionSource).toContain('projectRunFacts');
  });

  it('derives command actions from gateway descriptors instead of a second registry', () => {
    expect(gatewayProjectionSource).toContain('source.listOps()');
    expect(gatewayProjectionSource).toContain('source.dispatch');
    expect(gatewayProjectionSource).toContain('projectGatewayActions');
    expect(gatewayProjectionSource).not.toContain('registerAction');
    expect(gatewayProjectionSource).not.toContain('new Map');
    expect(gatewayProjectionSource).not.toContain('setSelection');
  });
});
