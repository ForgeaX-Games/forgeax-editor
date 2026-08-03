// Gateway selection read model — R0-03F.
//
// Selection remains transient editor state owned by store/selection.ts. This
// file only names the serializable projection that the Gateway exposes to both
// the human panels and the AI eval surface; it must not grow a second selection
// set or a second primary-selection rule.

import type { EntityHandle } from '../scene/scene-types';

export interface SelectionReadModel {
  /** The last selected handle, or null when the selection is empty. */
  readonly primary: EntityHandle | null;
  /** Selected handles in selection order; the last entry is primary. */
  readonly ids: readonly EntityHandle[];
}
