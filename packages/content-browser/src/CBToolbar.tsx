import { useCallback, useEffect, useRef, useState } from 'react';
import { buildAcceptString, dispatchActiveEditorOperation, generateAssetGuid, logImport, resolveGamePath, panelBridge, validateAssetBasename } from '@forgeax/editor-core';
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
import { CONTENT_BROWSER_INTERACTION_SCOPE, contentBrowserPrompt } from './interaction-surface';
import { importFiles, type ImportProgress } from './import-pipeline';
import { CREATABLE_ASSET_KINDS, type CreatableAssetSpec } from './creatable-asset-kinds';
import { createMaterialInstanceAndOpen } from './create-material-instance';
import { createInputMapAndOpen } from './create-input-map';
import { ContentBrowserIcon } from './content-browser-icons';
import { requestSaveAll } from './save-all-bus';
import { pickNativeImportFiles } from './native-file-picker';

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

  // Game-relative directory for authoring ops (appliers resolve to disk).
  const packDir = (currentPath || 'assets').replace(/^\/+|\/+$/g, '') || 'assets';
  // Host-resolved path — only for import diagnostics / file picker context.
  const basePath = resolveGamePath(packDir);
  const projectPath = resolveGamePath('');

  useEffect(() => {
    const input = fileInputRef.current;
    logImport('CBToolbar.mount', {
      currentPath,
      basePath,
      projectPath,
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
    void (async () => {
      const name = (await contentBrowserPrompt({
        title: t('editor.contentBrowser.actions.createAsset', { label: spec.label }),
        label: t('editor.contentBrowser.dialogs.newAssetNameLabel'),
        defaultValue: spec.defaultNamePrefix,
        placeholder: spec.defaultNamePrefix,
        confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
        cancelText: t('editor.contentBrowser.dialogs.cancel'),
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
      }))?.trim();
      if (!name) return;

      if (spec.kind === 'scene') {
        const requestId = crypto.randomUUID();
        const result = await dispatchActiveEditorOperation({
          kind: 'createSceneFile',
          id: name,
          duplicateCurrent: false,
          requestId,
        }, 'human');
        if (!result.ok) toast.error('createSceneFile', { description: result.error.hint });
        return;
      }

      if (spec.kind === 'material') {
        void dispatchActiveEditorOperation({
          kind: 'createMaterial',
          guid: generateAssetGuid(),
          name,
          baseColor: [1, 1, 1, 1],
          metallic: 0,
          roughness: 0.5,
          packPath: `${packDir}/Materials.pack.json`,
        }, 'human');
        return;
      }

      if (spec.kind === 'material-instance') {
        await createMaterialInstanceAndOpen(name, packDir);
        return;
      }

      if (spec.kind === 'input-map') {
        await createInputMapAndOpen(name, packDir);
        return;
      }

      void dispatchActiveEditorOperation({
        kind: 'createAsset',
        packPath: `${packDir}/${name}.pack.json`,
        guid: generateAssetGuid(),
        assetKind: spec.kind,
        name,
      }, 'human');
    })();
  }, [packDir, t]);

  const handleNewFolder = useCallback(() => {
    setAddMenuOpen(false);
    void contentBrowserPrompt({
      title: t('editor.contentBrowser.actions.createFolder'),
      label: t('editor.contentBrowser.dialogs.newFolderPrompt'),
      confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
      cancelText: t('editor.contentBrowser.dialogs.cancel'),
      validate: (v) => {
        const r = validateAssetBasename(v);
        return r.ok ? null : r.hint;
      },
    }).then(async (name) => {
      if (!name) return;
      const result = await dispatchActiveEditorOperation({ kind: 'createDirectory', parentPath: currentPath, name }, 'human');
      // Belt+suspenders: contentBrowserPrompt.validate already blocked bad input, but
      // a schema/logic bug or an AI-parity concurrent dispatch could still
      // surface INVALID_ARGS at dispatch time. Toast if so.
      if (!result.ok) toast.error('createDirectory', { description: result.error.hint });
    });
  }, [currentPath, t]);

  const importSelectedFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      logImport('CBToolbar.import.cancel', { reason: 'no files selected' });
      return;
    }

    logImport('CBToolbar.import.selected', {
      count: files.length,
      names: files.map(file => file.name),
      currentPath,
      basePath,
    });

    onImportProgress?.({ total: files.length, completed: 0, current: '', results: [], runs: [] });

    const results = await importFiles(
      files,
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

    if (errors.length === 0) setTimeout(() => onImportProgress?.(null), 3000);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [basePath, currentPath, onImportProgress, onReload]);

  const handleImport = useCallback(() => {
    const input = fileInputRef.current;
    logImport('CBToolbar.import.click', {
      currentPath,
      basePath,
      projectPath,
      accept: acceptString,
      hasFbx: acceptString.includes('.fbx'),
      acceptDom: input?.getAttribute('accept') ?? input?.accept ?? null,
    });
    void (async () => {
      const nativePick = await pickNativeImportFiles(projectPath);
      if (nativePick.kind === 'selected') {
        await importSelectedFiles(nativePick.files);
        return;
      }
      if (nativePick.kind === 'cancelled') return;
      input?.click();
    })();
  }, [acceptString, basePath, currentPath, importSelectedFiles, projectPath]);

  const handleFileSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      logImport('CBToolbar.import.cancel', { reason: 'no files selected' });
      return;
    }
    void importSelectedFiles(Array.from(files));
  }, [importSelectedFiles]);

  const handleSaveAll = useCallback(() => {
    void requestSaveAll();
  }, []);

  return (
    <div className="cb-toolbar">
      <div className="cb-toolbar-group">
        <DropdownMenu modal={false} open={addMenuOpen} onOpenChange={setAddMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="subtle">+ {t('editor.contentBrowser.actions.create')}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" interactionScope={CONTENT_BROWSER_INTERACTION_SCOPE}>
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
