import { expect, test } from 'bun:test';

import {
  decodeTransportCursor,
  paginateCollection,
} from '../service';

test('cursor pagination has stable continuation and no missing or duplicate items', () => {
  const values = ['a', 'b', 'c', 'd', 'e'];
  const seen: string[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  do {
    const page = paginateCollection(values, { limit: 2, cursor, snapshotRevision: 'rev-1' });
    seen.push(...page.items);
    cursor = page.nextCursor;
    pageCount++;
    expect(page.snapshotRevision).toBe('rev-1');
    if (cursor !== undefined) expect(decodeTransportCursor(cursor)).toMatchObject({ revision: 'rev-1' });
  } while (cursor !== undefined);

  expect(pageCount).toBe(3);
  expect(seen).toEqual(values);
});

test('a cursor from another snapshot is rejected instead of silently reordering results', () => {
  const first = paginateCollection(['a', 'b'], { limit: 1, snapshotRevision: 'rev-1' });
  expect(first.nextCursor).toBeTruthy();
  const next = paginateCollection(['a', 'c'], {
    limit: 1,
    cursor: first.nextCursor,
    snapshotRevision: 'rev-2',
  });
  expect(next).toMatchObject({ ok: false, error: { code: 'cursor-revision-conflict', retryable: false } });
});
