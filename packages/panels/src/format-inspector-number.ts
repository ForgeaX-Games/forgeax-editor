import type { FieldSchema } from '@forgeax/editor-core';

/** Fraction digits for read-only Inspector number display (not commit precision). */
export function inspectorNumberDecimals(fs: FieldSchema | undefined): number {
  const step = fs?.step ?? 0.1;
  if (step >= 1) return 0;
  if (step >= 0.1) return 3;
  if (step >= 0.01) return 4;
  if (step >= 0.001) return 5;
  return 6;
}

/** Compact display string for numeric Inspector fields — trims float noise. */
export function formatInspectorNumber(n: number, fs?: FieldSchema): string {
  if (!Number.isFinite(n)) return String(n);
  const decimals = inspectorNumberDecimals(fs);
  if (decimals === 0) return String(Math.round(n));
  const fixed = n.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
