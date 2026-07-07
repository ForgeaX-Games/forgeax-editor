import { useEffect, useRef } from 'react';
import type { CBAsset } from './types';
import type { DeleteImpact } from './delete-guard';

export interface DeleteGuardDialogProps {
  /** Assets queued for deletion. */
  targets: readonly CBAsset[];
  /** Reference impact from {@link computeDeleteImpact}. */
  impact: DeleteImpact;
  /** Resolve a guid to a human-readable label for the referencer list. */
  nameByGuid: (guid: string) => string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Delete guard (C3) — replaces the old `window.confirm` with a reference-aware
 * modal. When a target is still referenced from outside the delete batch we
 * surface the referencers so the user doesn't silently break a scene/material,
 * matching UE/Godot delete-protection behaviour. Both the keyboard `Delete`
 * path and the context-menu path route through this single dialog.
 */
export function DeleteGuardDialog({
  targets,
  impact,
  nameByGuid,
  onConfirm,
  onCancel,
}: DeleteGuardDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onConfirm, onCancel]);

  const count = targets.length;
  const danger = impact.hasExternalReferencers;

  return (
    <div className="cb-dialog-overlay" onClick={onCancel}>
      <div
        className="cb-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm delete"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cb-dialog-title">
          {danger ? '⚠ ' : ''}Delete {count} asset{count === 1 ? '' : 's'}?
        </div>

        <div className="cb-dialog-body">
          <ul className="cb-dialog-list">
            {targets.map((t) => {
              const external = impact.externalReferencers.get(t.guid) ?? [];
              return (
                <li key={t.guid} className="cb-dialog-item">
                  <span className="cb-dialog-item-name">{t.name}</span>
                  {external.length > 0 && (
                    <span className="cb-dialog-item-refs">
                      referenced by {external.length}:{' '}
                      {external.map(nameByGuid).join(', ')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {danger ? (
            <p className="cb-dialog-warn">
              Some assets are still referenced by other assets. Deleting them may
              break those references.
            </p>
          ) : (
            <p className="cb-dialog-note">This action cannot be undone.</p>
          )}
        </div>

        <div className="cb-dialog-actions">
          <button className="cb-dialog-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className={`cb-dialog-btn ${danger ? 'cb-dialog-btn-danger' : 'cb-dialog-btn-primary'}`}
            onClick={onConfirm}
          >
            Delete{danger ? ' anyway' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
