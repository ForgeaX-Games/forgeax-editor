// DeleteGuardDialogHost — bus adapter that renders the shared props-based
// <DeleteGuardDialog/> whenever the delete-guard-bus has a pending request.
//
// Standalone (and other hosts running the keyboard router outside the React
// tree) mount ONE <DeleteGuardDialogHost/> on a dedicated root; the router
// deps call requestDeleteGuard(...) to raise a modal, and this host resolves
// it via the shared dialog. Reference-aware impact analysis (C3) is computed
// on the fly from the engine AssetRegistry so router-driven deletes get the
// same "still referenced from…" warning the Content Browser context-menu
// delete does.

import { useEffect, useMemo, useState } from 'react';
import { gateway } from '@forgeax/editor-core';
import { DeleteGuardDialog } from './DeleteGuardDialog';
import { buildAssetGraph, type AssetGraphNode } from './hooks/useAssetGraph';
import { computeDeleteImpact, type DeleteImpact } from './delete-guard';
import {
  subscribeDeleteGuard,
  resolveDeleteGuard,
  type DeleteGuardRequest,
} from './delete-guard-bus';
import type { CBAsset } from './types';

// Registry surface we consume; kept local since content-browser has no direct
// type dep on the engine (the same shape appears in ContentBrowser.tsx).
interface RegistryCatalogEntry {
  guid: string;
  name?: string;
  refs?: readonly string[];
}
interface RegistrySurface {
  listCatalog?: () => readonly RegistryCatalogEntry[];
}

const EMPTY_IMPACT: DeleteImpact = {
  externalReferencers: new Map(),
  hasExternalReferencers: false,
  externalReferencerCount: 0,
};

function busAssetToCBAsset(a: DeleteGuardRequest['assets'][number]): CBAsset {
  return {
    type: 'asset',
    guid: a.guid,
    kind: '',
    name: a.name,
    payload: {},
    packPath: a.packPath,
    packIndex: -1,
    refs: [],
    estimatedSize: 0,
  };
}

export function DeleteGuardDialogHost() {
  const [req, setReq] = useState<DeleteGuardRequest | null>(null);
  useEffect(() => subscribeDeleteGuard(setReq), []);

  const targets = useMemo<CBAsset[]>(
    () => (req ? req.assets.map(busAssetToCBAsset) : []),
    [req],
  );

  // Snapshot the current catalog when the request opens. The dialog is short-
  // lived and the underlying registry rarely mutates during a confirm; sampling
  // once keeps the render pure and avoids subscribing to registry-change
  // notifications from a modal.
  const { impact, catalogNameByGuid } = useMemo(() => {
    if (!req) return { impact: EMPTY_IMPACT, catalogNameByGuid: new Map<string, string>() };
    const registry = gateway.doc.registry as RegistrySurface | undefined;
    const entries = registry?.listCatalog?.() ?? [];
    const nodes: AssetGraphNode[] = entries.map((e) => ({ guid: e.guid, refs: e.refs ?? [] }));
    const graph = buildAssetGraph(nodes);
    const nameByGuid = new Map<string, string>();
    for (const e of entries) if (e.name) nameByGuid.set(e.guid, e.name);
    for (const a of req.assets) nameByGuid.set(a.guid, a.name);
    return { impact: computeDeleteImpact(req.assets.map((a) => a.guid), graph), catalogNameByGuid: nameByGuid };
  }, [req]);

  if (!req) return null;

  return (
    <DeleteGuardDialog
      targets={targets}
      impact={impact}
      nameByGuid={(guid) => catalogNameByGuid.get(guid) ?? `${guid.slice(0, 8)}…`}
      onConfirm={() => resolveDeleteGuard(true)}
      onCancel={() => resolveDeleteGuard(false)}
    />
  );
}
