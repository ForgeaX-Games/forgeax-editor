import { useEffect, useState } from 'react';

// iter-109: ModelInfo shape carries the human label plus optional metadata
// the UI may need to render (id for model-picker, contextWindow for size
// warnings, etc.). Fields are optional so adding new ones is a no-op for
// call sites that ignore them. Keep the actual `CURRENT_MODEL` literal as
// label-only — the optional fields are surface for future cli-supplied data.
export interface ModelInfo {
  label: string;
  id?: string;
  contextWindow?: number;
}

// Single source of truth for the active LLM model label. Bump here whenever
// the @forgeax/cli backing changes; UI surfaces (TopBar pill, Composer model
// chip) reference this so they can never drift out of sync.
export const CURRENT_MODEL: ModelInfo = { label: 'Claude Opus 4.7' };

// Module-scope memo: TopBar pill + Composer model chip both call
// useModelLabel(), so without this each page load fires /api/health twice
// for the same byte-tiny response. Single fetch shared across consumers;
// failure is silent and falls back to the static CURRENT_MODEL label.
let _modelLabelPromise: Promise<string | null> | null = null;
function loadModelLabel(): Promise<string | null> {
  if (_modelLabelPromise) return _modelLabelPromise;
  _modelLabelPromise = fetch('/api/health')
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { model?: unknown } | null) => {
      if (j && typeof j.model === 'string' && j.model.length > 0) return j.model;
      return null;
    })
    .catch(() => null);
  return _modelLabelPromise;
}

// iter-108 origin: opportunistic dynamic label. If the server's /api/health
// surface grows a `model` string field (planned but not yet wired on the cli
// side), pick it up so we don't have to keep bumping CURRENT_MODEL by hand.
export function useModelLabel(): string {
  const [label, setLabel] = useState<string>(CURRENT_MODEL.label);
  useEffect(() => {
    let cancelled = false;
    void loadModelLabel().then((m) => {
      if (cancelled || !m) return;
      setLabel(m);
    });
    return () => { cancelled = true; };
  }, []);
  return label;
}
