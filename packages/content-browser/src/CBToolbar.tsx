import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildAcceptString,
  dispatchActiveEditorOperation,
  generateAssetGuid,
  kindRequiresCatalogRoot,
  logImport,
  resolveCatalogAuthoringDir,
  resolveGamePath,
  panelBridge,
  validateAssetBasename,
} from '@forgeax/editor-core';
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
import {
  createNameScopeForAssetKind,
  generateDefaultCreateName,
  type SiblingNameData,
} from './sibling-name';
import { ContentBrowserIcon } from './content-browser-icons';
import { requestSaveAll } from './save-all-bus';
import { pickNativeImportFiles, isNativeImportPickerCachedUnavailable } from './native-file-picker';
import type { CatalogAssetRoot } from './catalog-root';
import { creatableKindAllowedAtPath, localCatalogRoots } from './catalog-authoring-ui';

const DEFAULT_CATALOG_ROOTS: readonly CatalogAssetRoot[] = [{ root: 'assets', catalogPrefix: 'assets' }];

interface Props {
  currentPath: string;
  onReload: () => void;
  onImportProgress?: (progress: ImportProgress | null) => void;
  siblingNameData?: SiblingNameData;
  onNavigatePath?: (path: string) => void;
  catalogAssetRoots?: readonly CatalogAssetRoot[];
}

export function CBToolbar({
  currentPath,
  onReload,
  onImportProgress,
  siblingNameData,
  onNavigatePath: _onNavigatePath,
  catalogAssetRoots = DEFAULT_CATALOG_ROOTS,
}: Props) {
  const { t } = useTranslation();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const acceptString = buildAcceptString();

  // Game-relative directory for authoring ops (appliers resolve to disk).
  const packDir = (currentPath || 'assets').replace(/^\/+|\/+$/g, '') || 'assets';
  // Host-resolved path — only for import diagnostics / file picker context.
  const basePath = resolveGamePath(packDir);
  const projectPath = resolveGamePath('');

  useEffect(() => {
    const input = fileInputRef.current;
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
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
      const localRoots = localCatalogRoots(catalogAssetRoots);
      let targetDir: string;
      if (kindRequiresCatalogRoot(spec.kind)) {
        const resolved = resolveCatalogAuthoringDir(currentPath, localRoots);
        if (!resolved.ok) {
          toast.error(spec.kind === 'material' ? 'createMaterial' : 'createAsset', {
            description: t('editor.contentBrowser.catalogAuthoringOutsideAssets'),
          });
          return;
        }
        targetDir = resolved.dir;
      } else {
        targetDir = packDir;
      }

      const defaultName = siblingNameData
        ? generateDefaultCreateName(
          spec.defaultNamePrefix,
          createNameScopeForAssetKind(spec.kind, targetDir),
          siblingNameData,
        )
        : spec.defaultNamePrefix;
      const name = (await contentBrowserPrompt({
        title: t('editor.contentBrowser.actions.createAsset', { label: spec.label }),
        label: t('editor.contentBrowser.dialogs.newAssetNameLabel'),
        defaultValue: defaultName,
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

      if (spec.kind === 'scriptable-pack') {
        const result = await dispatchActiveEditorOperation({
          kind: 'asset-source.create',
          sourcePath: `${targetDir}/${name}.pack.ts`,
          name,
          initialOutput: { sourceKey: 'scene/main', kind: 'scene', name: `${name} Scene` },
          requestId: crypto.randomUUID(),
        }, 'human');
        if (!result.ok) toast.error('asset-source.create', { description: result.error.hint });
        return;
      }

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
          packPath: `${targetDir}/Materials.pack.json`,
        }, 'human');
        return;
      }

      if (spec.kind === 'material-instance') {
        await createMaterialInstanceAndOpen(name, targetDir);
        return;
      }

      if (spec.kind === 'input-map') {
        await createInputMapAndOpen(name, targetDir);
        return;
      }

      void dispatchActiveEditorOperation({
        kind: 'createAsset',
        packPath: `${targetDir}/${name}.pack.json`,
        guid: generateAssetGuid(),
        assetKind: spec.kind,
        name,
      }, 'human');
    })();
  }, [catalogAssetRoots, currentPath, packDir, siblingNameData, t]);

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
    if (folderInputRef.current) folderInputRef.current.value = '';
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
    if (!input) return;
    if (!projectPath || isNativeImportPickerCachedUnavailable()) {
      input.click();
      return;
    }
    void (async () => {
      const nativePick = await pickNativeImportFiles(projectPath);
      if (nativePick.kind === 'selected') {
        await importSelectedFiles(nativePick.files);
        return;
      }
      if (nativePick.kind === 'cancelled') return;
      input.click();
    })();
  }, [acceptString, basePath, currentPath, importSelectedFiles, projectPath]);

  const handleImportFolder = useCallback(() => {
    folderInputRef.current?.click();
  }, []);

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
            {CREATABLE_ASSET_KINDS.map(spec => {
              if (!creatableKindAllowedAtPath(spec.kind, currentPath, catalogAssetRoots)) return null;
              return (
              <DropdownMenuItem key={spec.kind} size="sm" onClick={() => handleCreateAsset(spec)}>
                <span className="cb-add-menu-icon">
                  <ContentBrowserIcon name={spec.icon} />
                </span>
                {spec.label}
              </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu modal={false} open={importMenuOpen} onOpenChange={setImportMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="subtle">{t('editor.contentBrowser.actions.import')}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" interactionScope={CONTENT_BROWSER_INTERACTION_SCOPE}>
            <DropdownMenuItem size="sm" onClick={handleImport}>
              {t('editor.contentBrowser.actions.import')}
            </DropdownMenuItem>
            <DropdownMenuItem size="sm" onClick={handleImportFolder}>
              {t('editor.contentBrowser.actions.importFolder')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
        <Input
          ref={folderInputRef}
          data-cb-folder-input="1"
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
