import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { RenderFeatureHost } from '@forgeax/engine-app';
import type {
  RenderError,
  Renderer,
  RenderFeature,
  RenderFeatureDiagnostics,
  RenderInspection,
  RenderResult,
} from '@forgeax/engine-render';
import type { RendererLegacyHostAdapter } from '@forgeax/engine-render/internal/construct-renderer';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { subscribeRendererFrameEnd } from './subscribe-renderer-frame-end';

export { subscribeRendererFrameEnd } from './subscribe-renderer-frame-end';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    rendererLegacyHost?: RendererLegacyHostAdapter;
  }
}

export interface EditorRendererHostDeps {
  readonly renderer: Renderer;
  readonly assets: AssetRegistry;
  readonly renderFeatureHost: RenderFeatureHost;
  /** When absent (pre-legacy-host engine pins), render-feature diagnostics degrade to empty. */
  readonly legacyHost?: Pick<RendererLegacyHostAdapter, 'renderFeatureDiagnostics'>;
}

/** Editor-facing renderer surface: public lease API + legacy diagnostics/shader hooks. */
export type EditorRendererHost = Renderer & {
  readonly shader: AssetRegistry['shaderRegistry'];
  readonly device: { readonly caps: RhiCaps };
  readonly backend: string;
  readonly ready: Promise<{ ok: boolean; error?: { message?: string; hint?: string; code?: string } }>;
  installRenderFeature(feature: RenderFeature<unknown>): Promise<RenderResult<void, RenderError>>;
  renderFeatureDiagnostics(): readonly RenderFeatureDiagnostics[];
  readonly frustumStats: RendererLegacyHostAdapter['frustumStats'];
  readonly visibilityStats: RendererLegacyHostAdapter['visibilityStats'];
  readonly renderScene: RendererLegacyHostAdapter['renderScene'];
  readonly meshMaterialBindings: RendererLegacyHostAdapter['meshMaterialBindings'];
  readonly perFramePassNames: RendererLegacyHostAdapter['perFramePassNames'];
  readonly bindGroupCounts: RenderInspection['bindGroupCounts'];
  onHealthChange(listener: () => void): () => void;
  subscribeFrameEnd(listener: () => void): () => void;
  subscribeRenderFeatureDiagnostics(listener: () => void): () => void;
};

export function createEditorRendererHost(deps: EditorRendererHostDeps): EditorRendererHost {
  const { renderer, assets, renderFeatureHost, legacyHost } = deps;
  const inspect = () => renderer.inspect();
  const bindFrameEnd = subscribeRendererFrameEnd(renderer);

  return {
    ...renderer,
    shader: assets.shaderRegistry,
    device: {
      get caps(): RhiCaps {
        return inspect().capabilities;
      },
    },
    get backend(): string {
      return inspect().capabilities.backendKind;
    },
    ready: (() => {
      const state = renderer.state();
      const ok = state === 'alive';
      return Promise.resolve({
        ok,
        ...(ok ? {} : { error: { code: 'renderer-not-ready', message: `Renderer state is ${state}` } }),
      });
    })(),
    installRenderFeature: async (feature) => {
      const installed = await renderFeatureHost.installFeature(feature);
      if (!installed.ok) return installed;
      return { ok: true, value: undefined };
    },
    renderFeatureDiagnostics: () => legacyHost?.renderFeatureDiagnostics() ?? [],
    get frustumStats() {
      return inspect().frustumStats;
    },
    get visibilityStats() {
      return inspect().visibilityStats;
    },
    get renderScene() {
      return inspect().renderScene;
    },
    get meshMaterialBindings() {
      return inspect().meshMaterialBindings;
    },
    get perFramePassNames() {
      return inspect().perFramePassNames;
    },
    get bindGroupCounts() {
      return inspect().bindGroupCounts;
    },
    subscribeFrameEnd(listener: () => void): () => void {
      return bindFrameEnd(listener);
    },
    onHealthChange(listener: () => void): () => void {
      return renderer.subscribe((event) => {
        if (event.kind === 'state-changed') listener();
      });
    },
    subscribeRenderFeatureDiagnostics(listener: () => void): () => void {
      const subscribe = (renderFeatureHost as {
        subscribeDiagnostics?: (notify: () => void) => () => void;
      }).subscribeDiagnostics;
      if (typeof subscribe === 'function') {
        return subscribe(listener);
      }
      // App-level renderFeatureHost wrapper (engine-app/renderer-plugin) exposes
      // installFeature only; poll diagnostics on completed frames instead of
      // failing boot when subscribeDiagnostics is absent on the pinned engine.
      return renderer.subscribe((event) => {
        if (event.kind === 'frame-submitted') listener();
      });
    },
  };
}

/** @deprecated Use createEditorRendererHost with explicit App pluginContext deps. */
export function asEditorRendererHost(deps: EditorRendererHostDeps): EditorRendererHost {
  return createEditorRendererHost(deps);
}
