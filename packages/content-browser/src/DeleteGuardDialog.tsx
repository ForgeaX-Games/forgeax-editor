import { useEffect, useRef } from 'react';
import { Button } from '@forgeax/editor-ui';
import { useTranslation } from '@forgeax/editor-core/i18n';
import type { CBAsset } from './types';
import type { DeleteImpact, SceneDeleteGuard } from './delete-guard';
import type { AssetPreflightResult } from '@forgeax/editor-core';

export interface DeleteGuardDialogProps {
  /** Assets queued for deletion. */
  targets: readonly CBAsset[];
  /** Reference impact from {@link computeDeleteImpact}. */
  impact: DeleteImpact;
  /** Scene-specific current/default/reference guard projection. */
  sceneGuards?: ReadonlyMap<string, SceneDeleteGuard>;
  preflight?: AssetPreflightResult;
  /** Resolve a guid to a human-readable label for the referencer list. */
  nameByGuid: (guid: string) => string;
  /** Latest Gateway refusal, if a race changed the authoritative guard. */
  error?: string | null;
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
  sceneGuards,
  preflight,
  nameByGuid,
  error,
  onConfirm,
  onCancel,
}: DeleteGuardDialogProps) {
  const { t } = useTranslation();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, [onConfirm, onCancel]);

  const count = targets.length;
  const hasSceneGuards = sceneGuards !== undefined && sceneGuards.size > 0;
  const danger = impact.hasExternalReferencers || hasSceneGuards;

  return (
    <div className="cb-dialog-overlay" data-testid="cb-delete-guard-overlay" onClick={onCancel}>
      <div
        className="cb-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('editor.contentBrowser.deleteGuard.ariaLabel')}
        data-testid="cb-delete-guard-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
        }}
        tabIndex={-1}
      >
        <div className="cb-dialog-title">
          {danger ? '⚠ ' : ''}{t('editor.contentBrowser.deleteGuard.title', { count, plural: count === 1 ? '' : 's' })}
        </div>

        <div className="cb-dialog-body">
          <ul className="cb-dialog-list">
            {targets.map((target) => {
              const external = impact.externalReferencers.get(target.guid) ?? [];
              return (
              <li key={target.guid} className="cb-dialog-item">
                <span className="cb-dialog-item-name">{target.name}</span>
                {sceneGuards?.get(target.guid)?.reasons.includes('current') && (
                  <span className="cb-dialog-item-refs">{t('editor.contentBrowser.deleteGuard.sceneCurrent')}</span>
                )}
                {sceneGuards?.get(target.guid)?.reasons.includes('default') && (
                  <span className="cb-dialog-item-refs">{t('editor.contentBrowser.deleteGuard.sceneDefault')}</span>
                )}
                {sceneGuards?.get(target.guid)?.reasons.includes('referenced') && (
                  <span className="cb-dialog-item-refs">
                    {t('editor.contentBrowser.deleteGuard.referencedBy', {
                      count: sceneGuards.get(target.guid)?.referencers.length ?? 0,
                      names: (sceneGuards.get(target.guid)?.referencers ?? []).map(nameByGuid).join(', '),
                    })}
                  </span>
                )}
                {external.length > 0 && (
                    <span className="cb-dialog-item-refs">
                      {t('editor.contentBrowser.deleteGuard.referencedBy', {
                        count: external.length,
                        names: external.map(nameByGuid).join(', '),
                      })}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {danger ? (
            <p className="cb-dialog-warn">
              {hasSceneGuards ? t('editor.contentBrowser.deleteGuard.sceneProtectedWarn') : t('editor.contentBrowser.deleteGuard.warn')}
            </p>
          ) : (
            <p className="cb-dialog-note">{t('editor.contentBrowser.deleteGuard.note')}</p>
          )}
          {preflight && (
            <p className="cb-dialog-note" data-testid="cb-delete-guard-revision">
              Revision {preflight.currentRevision}; recovery: {preflight.recoveryActions.join(', ')}
            </p>
          )}
          {error && <p className="cb-dialog-warn" data-testid="cb-delete-guard-error">{error}</p>}
        </div>

        <div className="cb-dialog-actions">
          <Button
            className="cb-dialog-btn"
            data-testid="cb-delete-guard-cancel"
            size="sm"
            variant="subtle"
            onClick={onCancel}
          >
            {t('editor.contentBrowser.deleteGuard.cancel')}
          </Button>
          {!hasSceneGuards && (
            <Button
              ref={confirmRef}
              className="cb-dialog-btn"
              data-testid="cb-delete-guard-confirm"
              size="sm"
              variant={danger ? 'destructive' : 'default'}
              onClick={onConfirm}
            >
              {danger ? t('editor.contentBrowser.deleteGuard.confirmAnyway') : t('editor.contentBrowser.deleteGuard.confirm')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
