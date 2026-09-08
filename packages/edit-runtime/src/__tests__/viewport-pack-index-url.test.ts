import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../viewport/ViewportComponent.tsx', import.meta.url), 'utf8');

describe('viewport asset catalog identity', () => {
  it('requires a host runtime binding instead of deriving a catalog from slug', () => {
    expect(source).toContain('runtimeBinding?: RuntimeAssetBinding');
    expect(source).toContain('expectedScope: binding');
    expect(source).not.toContain('resolveViewportPackIndexUrl');
    expect(source).not.toContain('/pack-index/');
  });

  it('does not construct a default import URL', () => {
    expect(source).not.toContain('/__import/');
  });

  it('passes the host runtime scope into the disposable Play URL', () => {
    const playUrlStart = source.indexOf('playChildUrl:');
    const playUrlEnd = source.indexOf('// DEV bridge follow-the-live-app', playUrlStart);
    const playUrlSource = source.slice(playUrlStart, playUrlEnd);

    expect(playUrlSource).toContain('const binding = requirePlayRuntimeBinding(gameSession.runtimeBinding);');
    expect(playUrlSource).toContain('playGeneration: String(generation)');
    expect(playUrlSource).toContain('runtimeScopeId: binding.scopeId');
    expect(playUrlSource).toContain('runtimeGeneration: String(binding.generation)');
    expect(playUrlSource).not.toContain('runtimeGeneration: String(runtimeIdentity.runtimeGeneration)');
    expect(playUrlSource).toContain('runtimeId: runtimeIdentity.runtimeId');
    expect(playUrlSource).toContain('carrierId: `${runtimeIdentity.carrierId}:play`');
    expect(playUrlSource).toContain("carrierKind: 'iframe'");
  });

  it('fails closed before constructing a mixed Play query', () => {
    expect(source).toContain('function requirePlayRuntimeBinding(binding: RuntimeAssetBinding | undefined)');
    expect(source).toContain("throw new Error('[editor] Play child URL requires a complete runtime asset binding')");
    expect(source).not.toContain("runtimeScopeId: gameSession.runtimeBinding?.scopeId ?? ''");
  });

  it('keeps runtime identity on the request and creation-run journal paths', () => {
    expect(source).toContain('scope: `viewport:${runtimeIdentity.runtimeId}:${runtimeIdentity.runtimeGeneration}`');
    expect(source).toContain('carrierGeneration: runtimeIdentity.runtimeGeneration');
    expect(source).toContain('runtimeGeneration: runtimeIdentity.runtimeGeneration');
  });
});
