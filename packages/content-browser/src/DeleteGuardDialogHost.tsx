// DeleteGuardDialogHost — bus adapter that renders the shared props-based
// <DeleteGuardDialog/> whenever the delete-guard-bus has a pending request.
//
// Standalone (and other hosts running the keyboard router outside the React
// tree) mount ONE <DeleteGuardDialogHost/> on a dedicated root; the router
// deps call requestDeleteGuard(...) to raise a modal, and this host resolves
// it via the shared dialog. Reference-aware impact analysis (C3) consumes the
// Content Browser's latest workspace projection so router-driven deletes get
// the same "still referenced from…" warning as context-menu deletes.

import { useEffect, useMemo, useState } from 'react';
import { DeleteGuardDialog } from './DeleteGuardDialog';
import { computeDeleteImpact } from './delete-guard';
import {
  getDeleteGuardWorkspace,
  subscribeDeleteGuard,
  resolveDeleteGuard,
  type DeleteGuardRequest,
} from './delete-guard-bus';
import type { CBAsset } from './types';

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

  const { impact, catalogNameByGuid } = useMemo(() => {
    const nameByGuid = new Map<string, string>();
    for (const a of req?.assets ?? []) nameByGuid.set(a.guid.toLowerCase(), a.name);
    const workspace = req?.workspace ?? getDeleteGuardWorkspace();
    for (const subject of workspace?.subjects ?? []) {
      if (subject.name) nameByGuid.set(subject.id.toLowerCase(), subject.name);
    }
    return {
      impact: computeDeleteImpact(
        (req?.assets ?? []).map((asset) => asset.guid),
        workspace ?? {
          schemaVersion: 'asset-workspace/v1',
          revision: 'workspace:r0',
          resourceRevision: 'resource:r0',
          identity: 'workspace-snapshot:empty',
          subjects: [],
          relations: [],
          issues: [],
        },
      ),
      catalogNameByGuid: nameByGuid,
    };
  }, [req]);

  if (!req) return null;

  return (
    <DeleteGuardDialog
      targets={targets}
      impact={impact}
      openResources={req.openResources}
      nameByGuid={(guid) => catalogNameByGuid.get(guid.toLowerCase()) ?? `${guid.slice(0, 8)}…`}
      onConfirm={() => resolveDeleteGuard(true)}
      onCancel={() => resolveDeleteGuard(false)}
    />
  );
}
