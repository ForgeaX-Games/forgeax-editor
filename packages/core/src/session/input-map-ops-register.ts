// Side-effect registration for Input Map document appliers.

import { registerApplier, type ApplierFn } from '../io/appliers';
import { applyCreateInputMap, applySaveInputMap } from './input-map-ops';

registerApplier('document', 'createInputMap', applyCreateInputMap as unknown as ApplierFn);
registerApplier('document', 'saveInputMap', applySaveInputMap as unknown as ApplierFn);
