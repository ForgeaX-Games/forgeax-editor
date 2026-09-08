// Content Browser DnD — React glue. Two hooks keep every draggable/droppable
// surface (grid file/folder tiles, source-tree rows, breadcrumb) behaving
// identically, so the policy is enforced in exactly one place.
//
//   useDragSource(getPayload)   — makes an element a move source.
//   useFolderDropZone(target,onMove) — makes an element a move drop target with
//                                       a live verdict + hover state.

import { useCallback, useMemo, useState, type DragEvent } from 'react';
import {
  beginActiveDrag,
  currentActiveDrag,
  dragEventCarriesMove,
  endActiveDrag,
  readDragPayload,
  writeDragPayload,
  type CBDragPayload,
  type CBDropTarget,
} from './model';
import { evaluateDrop } from './policy';
import type { DropVerdict } from './model';

export interface DragSourceProps {
  readonly draggable: true;
  readonly onDragStart: (e: DragEvent) => void;
  readonly onDragEnd: (e: DragEvent) => void;
}

/** Make an element a move source. `getPayload` is called at dragstart so the
 *  payload reflects the live multi-selection at pick-up time (returns null to
 *  veto the drag — e.g. an unmovable subject). */
export function useDragSource(getPayload: () => CBDragPayload | null): DragSourceProps {
  const onDragStart = useCallback((e: DragEvent) => {
    const payload = getPayload();
    if (!payload || payload.entries.length === 0) {
      e.preventDefault();
      return;
    }
    writeDragPayload(e.dataTransfer, payload);
    beginActiveDrag(payload);
  }, [getPayload]);

  const onDragEnd = useCallback(() => {
    endActiveDrag();
  }, []);

  return useMemo(() => ({ draggable: true, onDragStart, onDragEnd }), [onDragStart, onDragEnd]);
}

export interface FolderDropZone {
  /** True while a compatible move drag hovers (whether or not it's droppable). */
  readonly isOver: boolean;
  /** Live verdict for the hovering drag — powers accept/reject styling + reason. */
  readonly verdict: DropVerdict | null;
  readonly dropProps: {
    readonly onDragEnter: (e: DragEvent) => void;
    readonly onDragOver: (e: DragEvent) => void;
    readonly onDragLeave: (e: DragEvent) => void;
    readonly onDrop: (e: DragEvent) => void;
  };
}

/** Make an element a move drop target. Ignores non-move drags (OS file imports,
 *  viewport-placement copies) so the existing root import-drop path is untouched.
 *  A rejected drop keeps `dropEffect='none'` and never fires `onMove`, but still
 *  reports its `verdict` so the caller can explain WHY (point 3). */
export function useFolderDropZone(
  target: CBDropTarget,
  onMove: (payload: CBDragPayload, target: CBDropTarget) => void,
): FolderDropZone {
  const [isOver, setIsOver] = useState(false);
  const [verdict, setVerdict] = useState<DropVerdict | null>(null);

  const handleOver = useCallback((e: DragEvent) => {
    if (!dragEventCarriesMove(e.dataTransfer.types)) return;
    // Claim the event so it doesn't bubble to the root import-drop handler.
    e.preventDefault();
    e.stopPropagation();
    const result = evaluateDrop(currentActiveDrag(), target);
    e.dataTransfer.dropEffect = result.ok ? 'move' : 'none';
    setIsOver(true);
    setVerdict(result);
  }, [target]);

  const handleLeave = useCallback((e: DragEvent) => {
    if (!dragEventCarriesMove(e.dataTransfer.types)) return;
    setIsOver(false);
    setVerdict(null);
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    if (!dragEventCarriesMove(e.dataTransfer.types)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);
    setVerdict(null);
    const payload = readDragPayload(e.dataTransfer);
    const result = evaluateDrop(payload, target);
    if (result.ok && payload) onMove(payload, target);
    endActiveDrag();
  }, [target, onMove]);

  const dropProps = useMemo(() => ({
    onDragEnter: handleOver,
    onDragOver: handleOver,
    onDragLeave: handleLeave,
    onDrop: handleDrop,
  }), [handleOver, handleLeave, handleDrop]);

  return { isOver, verdict, dropProps };
}
