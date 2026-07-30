import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  getAuthoredVersion,
  notifyAuthoredChanged,
  subscribeAuthoredChanges,
  subscribeDocVersion,
} from '../store/doc-version';

const hostSession = readFileSync(resolve(import.meta.dir, '../../../edit-runtime/src/viewport/host-session.ts'), 'utf8');

describe('authored-only doc version contract', () => {
  it('does not let the Play frame callback write the authored signal', () => {
    expect(hostSession).not.toContain('notifyDocChanged();');
  });

  it('publishes authored mutations without touching the document channel', () => {
    let authoredNotifications = 0;
    let documentNotifications = 0;
    const offAuthored = subscribeAuthoredChanges(() => { authoredNotifications += 1; });
    const offDocument = subscribeDocVersion(() => { documentNotifications += 1; });
    const before = getAuthoredVersion();

    notifyAuthoredChanged();

    expect(getAuthoredVersion()).toBe(before + 1);
    expect(authoredNotifications).toBe(1);
    expect(documentNotifications).toBe(0);
    offAuthored();
    offDocument();
  });
});
