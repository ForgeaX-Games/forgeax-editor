import { expect, test } from 'bun:test';

import { fileSpecificMenuItems } from './content-browser-format';

const t = ((key: string) => key) as never;

test('scene default menu projects the Gateway scene read model', () => {
  const target = fileSpecificMenuItems(t, { family: 'scene' }, undefined, {
    sceneGuid: 'guid-lvl2',
    defaultSceneGuid: 'guid-lvl1',
  }).find((item) => item.id === 'set-default-scene');
  expect(target?.disabled).toBe(false);

  const current = fileSpecificMenuItems(t, { family: 'scene' }, undefined, {
    sceneGuid: 'guid-lvl1',
    defaultSceneGuid: 'guid-lvl1',
  }).find((item) => item.id === 'set-default-scene');
  expect(current?.disabled).toBe(true);
});
