import { useCallback, useState, type DragEvent } from 'react';
import {
  activeDragForDropTarget,
  ASSET_DRAG_MIME,
  carriesAssetMime,
  dropClassForVerdict,
  parseDroppedGuid,
  resolveAssetDropVerdict,
  type AssetDropVerdict,
} from './asset-ref-drop';
import { isGuidCompatibleWithAssetType } from './asset-ref-contract';

export interface UseAssetRefDropOptions {
  assetType: string;
  readOnly?: boolean;
  acceptKinds?: ReadonlySet<string>;
  onBind: (guid: string) => void;
}

export function useAssetRefDrop({
  assetType,
  readOnly = false,
  acceptKinds,
  onBind,
}: UseAssetRefDropOptions) {
  const [verdict, setVerdict] = useState<AssetDropVerdict>('none');

  const clearVerdict = useCallback(() => setVerdict('none'), []);

  const refreshVerdict = useCallback((event: DragEvent<HTMLElement>) => {
    if (readOnly) return;
    const drag = activeDragForDropTarget(event.dataTransfer);
    if (!drag && !carriesAssetMime(event.dataTransfer)) {
      setVerdict('none');
      return;
    }
    setVerdict(resolveAssetDropVerdict(assetType, drag, acceptKinds));
  }, [acceptKinds, assetType, readOnly]);

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (readOnly) return;
    if (!carriesAssetMime(event.dataTransfer) && !activeDragForDropTarget(event.dataTransfer)) return;
    event.preventDefault();
    refreshVerdict(event);
  }, [readOnly, refreshVerdict]);

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    const related = event.relatedTarget as Node | null;
    if (related && event.currentTarget.contains(related)) return;
    clearVerdict();
  }, [clearVerdict]);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (readOnly) return;
    if (!carriesAssetMime(event.dataTransfer) && !activeDragForDropTarget(event.dataTransfer)) return;
    event.preventDefault();
    const drag = activeDragForDropTarget(event.dataTransfer);
    const next = resolveAssetDropVerdict(assetType, drag, acceptKinds);
    setVerdict(next);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = next === 'accept' ? 'copy' : 'none';
    }
  }, [acceptKinds, assetType, readOnly]);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (readOnly) return;
    event.preventDefault();
    clearVerdict();
    const guid = parseDroppedGuid(event);
    if (!guid) return;

    if (acceptKinds) {
      try {
        const ref = JSON.parse(event.dataTransfer.getData(ASSET_DRAG_MIME)) as { kind?: string };
        if (!acceptKinds.has(ref.kind ?? '')) return;
      } catch {
        return;
      }
    } else if (!isGuidCompatibleWithAssetType(guid, assetType)) {
      return;
    }
    onBind(guid);
  }, [acceptKinds, assetType, clearVerdict, onBind, readOnly]);

  return {
    dropClassName: dropClassForVerdict(verdict),
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
  };
}
