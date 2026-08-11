import { describe, expect, it } from 'bun:test';
import {
  broadcastAssetsChanged,
  subscribeAssetsChanged,
  type AssetsChangedEvent,
} from '../../store/assets-changed';

describe('assets changed subscription', () => {
  it('projects disk-watch source and stops after unsubscribe', () => {
    const events: AssetsChangedEvent[] = [];
    const unsubscribe = subscribeAssetsChanged((event) => {
      events.push(event);
    });

    broadcastAssetsChanged('pack-changed', 'disk-watch');
    unsubscribe();
    broadcastAssetsChanged(undefined, 'local-op');

    expect(events).toEqual([{ hint: 'pack-changed', source: 'disk-watch' }]);
  });

  it('projects a GUID-addressed local lifecycle mutation', () => {
    const events: AssetsChangedEvent[] = [];
    const unsubscribe = subscribeAssetsChanged((event) => {
      events.push(event);
    });

    broadcastAssetsChanged('pack-changed', 'local-op', {
      kind: 'renamed',
      guid: 'input-map-guid',
      name: 'IM_Player',
    });
    unsubscribe();

    expect(events).toEqual([{
      hint: 'pack-changed',
      source: 'local-op',
      mutation: {
        kind: 'renamed',
        guid: 'input-map-guid',
        name: 'IM_Player',
      },
    }]);
  });
});
