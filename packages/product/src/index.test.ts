import { expect, test } from 'bun:test';

import { createEditorProduct } from './index';

test('product entry exposes a UI-free blocking contract', () => {
  const product = createEditorProduct();
  const discovered = product.discover();

  expect(discovered.manifest.productId).toBe('@forgeax/editor-product');
  expect(discovered.manifest.uiFree).toBe(true);
  expect(discovered.availability).toMatchObject({
    available: false,
    blocking: true,
    code: 'wave1-input-blocked',
  });
});
