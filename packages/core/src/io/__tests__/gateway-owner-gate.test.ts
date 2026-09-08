import { describe, expect, it } from 'bun:test';
import { assertThinGatewayOwnerSurface } from '../gateway';

describe('Gateway owner gate', () => {
  it('rejects a Gateway surface that owns a descriptor, registry, executor, or RunJournal', () => {
    expect(() => assertThinGatewayOwnerSurface({ descriptor: {}, registry: {}, executor: {}, runJournal: {} })).toThrow(/thin gateway/i);
    expect(() => assertThinGatewayOwnerSurface({ projection: true })).not.toThrow();
  });
});
