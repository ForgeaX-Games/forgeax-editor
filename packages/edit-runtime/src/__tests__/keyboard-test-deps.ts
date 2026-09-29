import { mock } from 'bun:test';
import type { KeyboardRouterDepsShape } from '../keyboard-router-deps';

type KeyboardTestReads = Pick<KeyboardRouterDepsShape,
  'getEntitySelection' | 'getAssetSelection' | 'getLastSelectionDomain'
  | 'isPlayMode' | 'getDisplay' | 'getInputTarget'>;

export function createKeyboardTestDeps(overrides: Partial<KeyboardTestReads> = {}) {
  const deps = {
    dispatch: mock<KeyboardRouterDepsShape['dispatch']>(() => {}),
    getEntitySelection: mock(overrides.getEntitySelection ?? (() => [7, 11])),
    getAssetSelection: mock<KeyboardRouterDepsShape['getAssetSelection']>(overrides.getAssetSelection ?? (() => [])),
    getLastSelectionDomain: mock<KeyboardRouterDepsShape['getLastSelectionDomain']>(overrides.getLastSelectionDomain ?? (() => 'entity')),
    isPlayMode: mock(overrides.isPlayMode ?? (() => false)),
    getDisplay: mock<KeyboardRouterDepsShape['getDisplay']>(overrides.getDisplay ?? (() => 'scene')),
    getInputTarget: mock<KeyboardRouterDepsShape['getInputTarget']>(overrides.getInputTarget ?? (() => 'editor')),
    deleteEntities: mock<KeyboardRouterDepsShape['deleteEntities']>(() => {}),
    duplicateEntities: mock<KeyboardRouterDepsShape['duplicateEntities']>(() => {}),
    hideEntities: mock<KeyboardRouterDepsShape['hideEntities']>(() => {}),
    showAllHidden: mock(() => {}),
    hideUnselected: mock(() => {}),
    selectAllEntities: mock(() => {}),
    duplicateAsset: mock<KeyboardRouterDepsShape['duplicateAsset']>(() => {}),
    undo: mock(() => {}),
    redo: mock(() => {}),
    save: mock(() => {}),
    restartPreview: mock(() => {}),
    handleViewportKeyDown: mock<KeyboardRouterDepsShape['handleViewportKeyDown']>(() => {}),
  };
  return deps;
}
