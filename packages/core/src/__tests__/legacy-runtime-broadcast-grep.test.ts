import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const runtimeFiles = [
  resolve(import.meta.dir, '../../../edit-runtime/src/viewport/host-session.ts'),
  resolve(import.meta.dir, '../../../edit-runtime/src/viewport/run-lifecycle.ts'),
  resolve(import.meta.dir, '../../../edit-runtime/src/viewport/play-assemble.ts'),
];

describe('legacy runtime broadcast migration gate', () => {
  it('captures every remaining Play runtime doc-version call-chain match', () => {
    const matches = runtimeFiles.flatMap((file) => readFileSync(file, 'utf8').split('\n')
      .map((line, index) => ({ file, line: index + 1, text: line }))
      .filter(({ text }) => text.includes('notifyDocChanged(') || text.includes('subscribeDocVersion(')));

    expect(matches).toEqual([]);
  });
});
