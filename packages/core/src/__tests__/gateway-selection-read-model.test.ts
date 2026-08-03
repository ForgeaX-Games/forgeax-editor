import { beforeEach, describe, expect, it } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EntityHandle } from '../scene/scene-types';
import type { EditorOp } from '../types';
import '../store/selection';

describe('Gateway selection read model', () => {
  let gateway: EditGateway;

  beforeEach(() => {
    gateway = new EditGateway(createEditSession());
    gateway.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp);
  });

  it('derives primary and ordered ids from the shared selection store', () => {
    gateway.dispatch({ kind: 'setSelectionMany', ids: [29, 30] } as EditorOp, 'ai');

    expect(gateway.selectionReadModel()).toEqual({
      primary: 30 as EntityHandle,
      ids: [29, 30] as EntityHandle[],
    });
  });

  it('returns an empty projection after the public clear-selection op', () => {
    gateway.dispatch({ kind: 'setSelection', id: 29 } as EditorOp);
    gateway.dispatch({ kind: 'setSelection', id: null } as EditorOp, 'ai');

    expect(gateway.selectionReadModel()).toEqual({ primary: null, ids: [] });
  });
});
