export interface VfxRenderCapabilities {
  readonly compute?: boolean;
  readonly indirectDrawing?: boolean;
}

/** GPU particle rendering is optional when the active RHI lacks its required caps. */
export function supportsVfxRenderFeature(
  capabilities: VfxRenderCapabilities | undefined,
): boolean {
  return capabilities?.compute === true && capabilities.indirectDrawing === true;
}
