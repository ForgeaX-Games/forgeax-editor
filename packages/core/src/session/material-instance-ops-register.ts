// Side-effect registration for Material Instance document appliers.
// Kept separate from material-instance-ops.ts so unit tests can import apply*
// helpers without pulling io/appliers → session/document → engine-scene.

import { registerApplier, type ApplierFn } from '../io/appliers';
import {
  applyCreateMaterialInstance,
  applySaveMaterialInstance,
  applySetMaterialInstanceLightmass,
  applySetMaterialInstanceOverride,
  applySetMaterialInstanceParent,
} from './material-instance-ops';

registerApplier('document', 'createMaterialInstance', applyCreateMaterialInstance as unknown as ApplierFn);
registerApplier('document', 'saveMaterialInstance', applySaveMaterialInstance as unknown as ApplierFn);
registerApplier('document', 'setMaterialInstanceParent', applySetMaterialInstanceParent as unknown as ApplierFn);
registerApplier('document', 'setMaterialInstanceOverride', applySetMaterialInstanceOverride as unknown as ApplierFn);
registerApplier('document', 'setMaterialInstanceLightmass', applySetMaterialInstanceLightmass as unknown as ApplierFn);
