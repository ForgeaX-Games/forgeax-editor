import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('ordinary and detached windows retain the complete runtime through the shared product owner', () => {
  const source = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
  expect(source.match(/<StandaloneRuntimeRoot\b/g)).toHaveLength(2);
  expect(source).not.toContain('startStandaloneApplication().then(({ host })');
  expect(source).toContain('host={runtime.host}');
});
