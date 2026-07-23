import { useCallback, useEffect, useRef, useState } from 'react';
import { broadcastAssetsChanged, resolveGamePath } from '@forgeax/editor-core';
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
} from '@forgeax/editor-ui';
import { prompt as promptDialog } from '@forgeax/editor-ui/prompt';
import { importFiles, type ImportProgress } from './import-pipeline';
import { buildAcceptString, logImport } from './import-registry';
import { CREATABLE_ASSET_KINDS, type CreatableAssetSpec } from './creatable-asset-kinds';
import { colorForAssetKind, ContentBrowserIcon } from './content-browser-icons';

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

  const handleCreateAsset = useCallback((spec: CreatableAssetSpec) => {
    setAddMenuOpen(false);
    void promptDialog({
      title: t('editor.contentBrowser.actions.createAsset', { label: spec.label }),
      label: t('editor.contentBrowser.dialogs.newAssetNameLabel'),
      defaultValue: spec.defaultNamePrefix,
      placeholder: spec.defaultNamePrefix,
      confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
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
    }).then((name) => {
      if (!name) return;
      gateway.dispatch({ kind: 'createDirectory', parentPath: currentPath, name }, 'human');
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
                <span className="cb-add-menu-icon" style={{ color: colorForAssetKind(spec.kind) }}>
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
