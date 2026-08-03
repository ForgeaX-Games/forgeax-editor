// visual-quality.ts — producer-owned render quality presets as one document op.
//
// R1-03 / AC-visual-quality: a quality preset is a named composition of the
// engine's existing render-component fields. It is not a second authored data
// format and it does not write the world directly. The applier reads component
// rows through DocApplierCtx.query, then re-enters the normal setComponent
// applier through one transaction so human and AI callers get the same ledger,
// undo, trace, and save behavior.
//
// The values below are policy, not engine schema. Component existence and field
// validation remain owned by the engine-reflected component schema at apply time.

import type { ApplyResult, EditorOp } from '../types';
import type { DocApplierCtx } from './document';

export const VISUAL_QUALITY_PRESETS = [
  { id: 'draft', label: 'Draft' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'cinematic', label: 'Cinematic' },
] as const;

export type VisualQualityPreset = (typeof VISUAL_QUALITY_PRESETS)[number]['id'];

type PresetPatches = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * Quality-only fields shared by the Inspector and the AI op. Artistic fields
 * such as light color, direction, and intensity intentionally stay untouched.
 */
export const VISUAL_QUALITY_PATCHES: Readonly<Record<VisualQualityPreset, PresetPatches>> = {
  draft: {
    Camera: { bloom: 0, bloomBlurRadius: 2 },
    DirectionalLight: { mapSize: 1024, cascadeCount: 2, pcfKernelSize: 1 },
    PointLightShadow: { mapSize: 256, pcfKernelSize: 1 },
    SpotLight: { mapSize: 1024, pcfKernelSize: 1 },
  },
  balanced: {
    Camera: { bloom: 1, bloomBlurRadius: 4 },
    DirectionalLight: { mapSize: 2048, cascadeCount: 4, pcfKernelSize: 3 },
    PointLightShadow: { mapSize: 512, pcfKernelSize: 3 },
    SpotLight: { mapSize: 2048, pcfKernelSize: 3 },
  },
  cinematic: {
    Camera: { bloom: 1, bloomBlurRadius: 8 },
    DirectionalLight: { mapSize: 4096, cascadeCount: 4, pcfKernelSize: 5 },
    PointLightShadow: { mapSize: 1024, pcfKernelSize: 5 },
    SpotLight: { mapSize: 4096, pcfKernelSize: 5 },
  },
};

function isVisualQualityPreset(value: unknown): value is VisualQualityPreset {
  return typeof value === 'string'
    && VISUAL_QUALITY_PRESETS.some((preset) => preset.id === value);
}

interface QueryRows {
  readonly ok: true;
  readonly rows: ReadonlyArray<{ readonly entity: number }>;
}

function queryRows(ctx: DocApplierCtx, component: string): QueryRows | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } } {
  const result = ctx.query({ with: [component] });
  if (typeof result !== 'object' || result === null) {
    return { ok: false, error: { code: 'QUERY_UNAVAILABLE', hint: `unable to query ${component}` } };
  }
  const value = result as { ok?: unknown; rows?: unknown; error?: { code?: unknown; hint?: unknown } };
  if (value.ok !== true || !Array.isArray(value.rows)) {
    return {
      ok: false,
      error: {
        code: typeof value.error?.code === 'string' ? value.error.code : 'QUERY_UNAVAILABLE',
        hint: typeof value.error?.hint === 'string' ? value.error.hint : `unable to query ${component}`,
      },
    };
  }
  return {
    ok: true,
    rows: value.rows.filter((row): row is { entity: number } =>
      typeof row === 'object'
      && row !== null
      && typeof (row as { entity?: unknown }).entity === 'number'),
  };
}

export function applyVisualQualityPreset(ctx: DocApplierCtx, command: EditorOp): ApplyResult {
  const preset = (command as { preset?: unknown }).preset;
  if (!isVisualQualityPreset(preset)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        hint: 'preset must be one of: draft, balanced, cinematic',
        details: { fieldPath: 'preset', allowed: VISUAL_QUALITY_PRESETS.map((item) => item.id) },
      },
    };
  }

  const commands: EditorOp[] = [];
  for (const [component, patch] of Object.entries(VISUAL_QUALITY_PATCHES[preset])) {
    const rows = queryRows(ctx, component);
    if (!rows.ok) {
      return { ok: false, error: { code: 'UNKNOWN_COMPONENT', hint: rows.error.hint, details: rows.error } };
    }
    for (const row of rows.rows) {
      commands.push({ kind: 'setComponent', entity: row.entity, component, patch: { ...patch } });
    }
  }

  if (commands.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        hint: 'the active scene has no Camera, shadow, DirectionalLight, or SpotLight component to tune',
        details: { preset, supportedComponents: Object.keys(VISUAL_QUALITY_PATCHES[preset]) },
      },
    };
  }

  return ctx.dispatchSub(ctx, {
    kind: 'transaction',
    label: `Apply ${preset} visual quality`,
    commands,
  });
}
