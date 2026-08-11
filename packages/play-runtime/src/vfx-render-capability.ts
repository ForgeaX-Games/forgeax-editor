// The particle simulation remains valid on every RHI, but the GPU particle
// render feature needs both capabilities before it can be installed.
export interface VfxRenderCapabilities {
  readonly compute?: boolean;
  readonly indirectDrawing?: boolean;
}

export function supportsVfxRenderFeature(
  capabilities: VfxRenderCapabilities | undefined,
): boolean {
  return capabilities?.compute === true && capabilities.indirectDrawing === true;
}
