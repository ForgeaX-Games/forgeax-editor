import { describe, expect, test } from 'bun:test';
import { createEditorKeyboardExtension } from '../editor-keyboard-extension';
import { createKeyboardTestDeps } from './keyboard-test-deps';
import type { KeyboardRouterDepsShape } from '../keyboard-router-deps';

describe('Editor menu focused text precedence', () => {
  for (const action of ['undo', 'redo', 'delete'] as const) {
    test(`${action} is consumed by the text owner before scene actions`, async () => {
      const deps = createKeyboardTestDeps();
      const seen: string[] = [];
      const commands = new Map<string, () => unknown>();
      let focused = true;
      const wired: KeyboardRouterDepsShape = {
        ...deps,
        executeFocusedTextEditAction: async (value) => {
          seen.push(value);
          return focused;
        },
      };
      const cleanup = createEditorKeyboardExtension(wired).setup!({
        registerCommand: ({ id, execute }: { id: string; execute: () => unknown }) => {
          commands.set(id, execute);
          return () => {};
        },
        host: { keybindings: { register: () => () => {} }, shortcuts: { register: () => () => {} } },
      } as never);
      const command = commands.get(`editor.${action}`)!;
      expect(await command()).toEqual({ status: 'completed' });
      expect(seen).toEqual([action]);
      const sceneAction = action === 'delete' ? deps.deleteEntities : deps[action];
      expect(sceneAction).not.toHaveBeenCalled();
      focused = false;
      await command();
      expect(sceneAction).toHaveBeenCalledTimes(1);
      if (typeof cleanup === 'function') cleanup();
    });
  }
});
