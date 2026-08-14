// material-render-state-facts — read-only Two Sided / Blend from the authored
// MaterialAsset pass renderState (cullMode / blend). Does not invent parallel
// fields; Lit/Unlit stay engine-owned.

export interface MaterialRenderStateFacts {
  readonly cullMode: string;
  readonly twoSided: boolean;
  readonly blendLabel: string;
}

function firstRenderState(payload: Record<string, unknown>): Record<string, unknown> {
  const passes = payload.passes;
  if (!Array.isArray(passes) || passes.length === 0) return {};
  const first = passes[0];
  if (typeof first !== 'object' || first === null) return {};
  const renderState = (first as { renderState?: unknown }).renderState;
  return typeof renderState === 'object' && renderState !== null
    ? renderState as Record<string, unknown>
    : {};
}

export function materialRenderStateFacts(payload: Record<string, unknown>): MaterialRenderStateFacts {
  const renderState = firstRenderState(payload);
  const cullMode = typeof renderState.cullMode === 'string' ? renderState.cullMode : 'back';
  const blend = renderState.blend;
  let blendLabel = 'Opaque';
  if (blend === true) blendLabel = 'Blend';
  else if (typeof blend === 'string' && blend.length > 0) blendLabel = blend;
  else if (typeof blend === 'object' && blend !== null) blendLabel = 'Blend';
  return {
    cullMode,
    twoSided: cullMode === 'none',
    blendLabel,
  };
}
