import { expect, test } from 'bun:test';
import { Gamepad2 } from 'lucide-react';
import {
  explicitIconForWorkbenchId,
  iconForWorkbenchModule,
} from './workbench-module-icons';

test('wb-game-video resolves to the gameplay icon', () => {
  expect(explicitIconForWorkbenchId('wb-game-video')).toBe(Gamepad2);
  expect(explicitIconForWorkbenchId('gamevideo')).toBeUndefined();
  expect(iconForWorkbenchModule({
    workbenchId: 'wb-game-video',
    extensionId: '@forgeax/wb-game-video',
  })).toBe(Gamepad2);
});
