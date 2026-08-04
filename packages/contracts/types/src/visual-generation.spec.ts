import { describe, expect, test } from 'bun:test';
import {
  VISUAL_PRESENTATION_PROGRAM_RESOURCE_KEY,
  VisualPresentationManifestSchema,
  commitVisualPresentation,
  getVisualPresentationProgram,
  type VisualResourceStore,
} from './visual-generation';

function createStore(): VisualResourceStore {
  const resources = new Map<string, unknown>();
  return {
    hasResource: (key) => resources.has(key),
    getResource: <T>(key: string) => resources.get(key) as T,
    insertResource: <T>(key: string, value: T) => resources.set(key, value),
  };
}

describe('visual presentation program', () => {
  test('atomically derives durable enter and exit transitions', () => {
    const store = createStore();
    const first = commitVisualPresentation(store, {
      operationId: 'one',
      state: {
        signals: { 'move.y': 1 },
        activeBehaviors: [{ recipeKey: 'cover-duck', instanceId: 'hero-posture' }],
      },
    });
    expect(first).toMatchObject({ disposition: 'accepted', revision: 1, transitionSequences: [1] });

    const second = commitVisualPresentation(store, {
      operationId: 'two',
      state: { signals: {}, activeBehaviors: [] },
    });
    expect(second.transitionSequences).toEqual([2]);
    expect(getVisualPresentationProgram(store)?.journal.entries.map((entry) => entry.type)).toEqual([
      'behavior-enter',
      'behavior-exit',
    ]);
    expect(store.hasResource(VISUAL_PRESENTATION_PROGRAM_RESOURCE_KEY)).toBe(true);
  });

  test('retains exact idempotency and rejects conflicting operation IDs', () => {
    const store = createStore();
    const commit = {
      operationId: 'same',
      state: { signals: {}, activeBehaviors: [] },
    };
    expect(commitVisualPresentation(store, commit).disposition).toBe('accepted');
    expect(commitVisualPresentation(store, commit).disposition).toBe('duplicate');
    expect(() => commitVisualPresentation(store, {
      ...commit,
      state: { signals: { wind: 1 }, activeBehaviors: [] },
    })).toThrow('idempotency-conflict');
  });

  test('validates recipe schemas without fixed gameplay vocabulary', () => {
    expect(VisualPresentationManifestSchema.parse({
      version: 2,
      entries: [{
        continuityKey: 'market-night',
        signals: [{ key: 'input.move-y', type: 'number', default: 0, min: -1, max: 1 }],
        baseline: {
          motion: [{
            id: 'walk',
            target: 'navigation.forward-rate',
            blend: 'add',
            source: { kind: 'signal', key: 'input.move-y' },
          }],
        },
        recipes: [{
          key: 'submarine-descend',
          active: {
            prompt: [{
              id: 'descent',
              slot: 'world',
              text: 'The vessel descends near {actor.id}.',
              mode: 'append',
            }],
          },
        }],
      }],
    })).toMatchObject({ version: 2 });
  });
});
