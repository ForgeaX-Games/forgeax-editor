import manifest from './fixtures/engine-baseline.json';

export interface EngineBaselineAdapter {
  readonly manifest: typeof manifest;
  activate(variant: 'web' | 'desktop'): { contribution: string; capability: string; variant: string };
}

export function createEngineBaselineAdapter(): EngineBaselineAdapter {
  return {
    manifest,
    activate: (variant) => {
      if (!manifest.variants.includes(variant)) throw new Error(`Unsupported engine variant: ${variant}`);
      return { contribution: 'engine.preview', capability: 'engine.preview.create', variant };
    },
  };
}
