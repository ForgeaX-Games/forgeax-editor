import { useCallback, useEffect, useRef, useState } from 'react';
import { broadcastAssetsChanged, resolveGamePath, panelBridge, validateAssetBasename } from '@forgeax/editor-core';
import { generateAssetGuid, gateway } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  toast,
} from '@forgeax/editor-ui';
import { prompt as promptDialog } from '@forgeax/editor-ui/prompt';
import { importFiles, type ImportProgress } from './import-pipeline';
import { buildAcceptString, logImport } from './import-registry';
import { CREATABLE_ASSET_KINDS, type CreatableAssetSpec } from './creatable-asset-kinds';
import { ContentBrowserIcon } from './content-browser-icons';

interface Props {
  currentPath: string;
  onReload: () => void;
  onImportProgress?: (progress: ImportProgress | null) => void;
}

export function CBToolbar({ currentPath, onReload, onImportProgress }: Props) {
  const { t } = useTranslation();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const acceptString = buildAcceptString();

  const basePath = resolveGamePath(currentPath || 'assets');

  useEffect(() => {
    const input = fileInputRef.current;
    logImport('CBToolbar.mount', {
      currentPath,
      basePath,
      accept: acceptString,
      hasFbx: acceptString.includes('.fbx'),
      acceptDom: input?.getAttribute('accept') ?? input?.accept ?? null,
    });
  }, [acceptString, basePath, currentPath]);

  // Toast subscriber for async asset-IO failures (dev-plan §5 step 3).
  // Installed once at CBToolbar mount, disposed on unmount. This is the ONE
  // subscriber for the whole editor because CBToolbar renders once per open
  // Content Browser panel; if the panel is closed the toast doesn't fire (the
  // user isn't in an asset-authoring context anyway). Emitted by
  // session/pack-ops.ts on .then(!ok) / .catch of fire-and-forget IO writes.
  useEffect(() => {
    return panelBridge.on('assetsError', ({ op, hint }) => {
      toast.error(op, { description: hint });
    });
  }, []);

  const handleCreateAsset = useCallback((spec: CreatableAssetSpec) => {
    setAddMenuOpen(false);
    void promptDialog({
      title: t('editor.contentBrowser.actions.createAsset', { label: spec.label }),
      label: t('editor.contentBrowser.dialogs.newAssetNameLabel'),
      defaultValue: spec.defaultNamePrefix,
      placeholder: spec.defaultNamePrefix,
      confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
      // The asset name becomes part of a filename (`${name}.pack.json`), so
      // basename rules apply — inline UX-side gate using the SSOT validator
      // (dev-plan §5 step 5 + follow-up validate wiring). The applier still
      // enforces on dispatch (north-star §9); this just fails the input BEFORE
      // Confirm is even enabled, so the user gets red text instead of a
      // silent toast/reject after the click.
      validate: (v) => {
        const r = validateAssetBasename(v);
        return r.ok ? null : r.hint;
      },
    }).then((result) => {
      const name = result?.trim();
      if (!name) return;
      gateway.dispatch({
        kind: 'createAsset',
        packPath: `${basePath}/${name}.pack.json`,
        guid: generateAssetGuid(),
        assetKind: spec.kind,
        name,
      }, 'human');
    });
  }, [basePath, t]);

  const handleNewFolder = useCallback(() => {
    setAddMenuOpen(false);
    void promptDialog({
      title: t('editor.contentBrowser.actions.createFolder'),
      label: t('editor.contentBrowser.dialogs.newFolderPrompt'),
      confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
      cancelText: t('editor.contentBrowser.dialogs.cancel'),
      validate: (v) => {
        const r = validateAssetBasename(v);
        return r.ok ? null : r.hint;
      },
    }).then((name) => {
      if (!name) return;
      const result = gateway.dispatch({ kind: 'createDirectory', parentPath: currentPath, name }, 'human');
      // Belt+suspenders: promptDialog.validate already blocked bad input, but
      // a schema/logic bug or an AI-parity concurrent dispatch could still
      // surface INVALID_ARGS at dispatch time. Toast if so.
      if (!result.ok) toast.error('createDirectory', { description: result.error.hint });
    });
  }, [currentPath, t]);

  const handleImport = useCallback(() => {
    const input = fileInputRef.current;
    logImport('CBToolbar.import.click', {
      currentPath,
      basePath,
      accept: acceptString,
      hasFbx: acceptString.includes('.fbx'),
      acceptDom: input?.getAttribute('accept') ?? input?.accept ?? null,
    });
    input?.click();
  }, [acceptString, basePath, currentPath]);

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      logImport('CBToolbar.import.cancel', { reason: 'no files selected' });
      return;
    }

    logImport('CBToolbar.import.selected', {
      count: files.length,
      names: Array.from(files).map(f => f.name),
      currentPath,
      basePath,
    });

    onImportProgress?.({ total: files.length, completed: 0, current: '', results: [] });

    const results = await importFiles(
      Array.from(files),
      currentPath,
      (progress) => onImportProgress?.(progress),
      onReload,
    );

    logImport('CBToolbar.import.done', {
      results: results.map(r => ({ filename: r.filename, status: r.status, error: r.error })),
    });

    const errors = results.filter(r => r.status === 'error');
    if (errors.length > 0) {
      console.warn('[CBToolbar] import errors:', errors.map(e => `${e.filename}: ${e.error}`));
    }

    setTimeout(() => onImportProgress?.(null), 3000);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [currentPath, onReload, onImportProgress]);

  const handleSaveAll = useCallback(() => {
    broadcastAssetsChanged();
  }, []);

  return (
    <div className="cb-toolbar">
      <div className="cb-toolbar-group">
        <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="subtle">+ {t('editor.contentBrowser.actions.create')}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem size="sm" onClick={handleNewFolder}>
              {t('editor.contentBrowser.actions.createFolder')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {CREATABLE_ASSET_KINDS.map(spec => (
              <DropdownMenuItem key={spec.kind} size="sm" onClick={() => handleCreateAsset(spec)}>
                <span className="cb-add-menu-icon">
                  <ContentBrowserIcon name={spec.icon} />
                </span>
                {spec.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button size="sm" variant="subtle" onClick={handleImport}>
          {t('editor.contentBrowser.actions.import')}
        </Button>
        <Input
          ref={fileInputRef}
          data-cb-file-input="1"
          size="sm"
          type="file"
          multiple
          accept={acceptString}
          style={{ display: 'none' }}
          onChange={e => void handleFileSelected(e)}
        />

        <Button size="sm" variant="subtle" onClick={handleSaveAll}>
          {t('editor.contentBrowser.actions.saveAll')}
        </Button>
      </div>
    </div>
  );
}
