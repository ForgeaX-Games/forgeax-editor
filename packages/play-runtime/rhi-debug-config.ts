import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';

type Environment = Readonly<Record<string, string | undefined>>;
type NamedPlugin = { readonly name: string };

/** Keep standalone capture opt-in and aligned with the host-provided start flag. */
export function standaloneRhiDebugPlugins(environment: Environment = process.env): readonly NamedPlugin[] {
  return environment.FORGEAX_ENGINE_RHI_DEBUG === '1'
    ? [vitePluginRhiDebug() as NamedPlugin]
    : [];
}
