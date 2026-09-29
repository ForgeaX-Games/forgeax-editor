import { describe, expect, it } from 'bun:test';
import { extractVisibilityCommandEntityIds, isVisibilityDocumentCommand } from '../io/hierarchy-visibility-trace';

describe('isVisibilityDocumentCommand', () => {
  it('matches setVisibility and visibility hierarchyGesture', () => {
    expect(isVisibilityDocumentCommand({ kind: 'setVisibility', entity: 1, state: 'hidden' })).toBe(true);
    expect(isVisibilityDocumentCommand({
      kind: 'hierarchyGesture',
      action: 'visibility',
      entities: [1],
      state: 'hidden',
    })).toBe(true);
  });

  it('ignores unrelated document ops', () => {
    expect(isVisibilityDocumentCommand({ kind: 'hierarchyGesture', action: 'reparent', entities: [1] })).toBe(false);
    expect(isVisibilityDocumentCommand({ kind: 'rename', entity: 1, name: 'x' })).toBe(false);
  });

  it('matches visibility inside transactions', () => {
    expect(isVisibilityDocumentCommand({
      kind: 'transaction',
      label: 'hide',
      commands: [{ kind: 'setVisibility', entity: 2, state: 'hidden' }],
    })).toBe(true);
  });
});

describe('extractVisibilityCommandEntityIds', () => {
  it('reads hierarchyGesture visibility entities', () => {
    expect(extractVisibilityCommandEntityIds({
      kind: 'hierarchyGesture',
      action: 'visibility',
      entities: [4, 9],
      state: 'hidden',
    })).toEqual([4, 9]);
  });
});
