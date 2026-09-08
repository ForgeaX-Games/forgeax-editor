import { expect, test } from 'bun:test';
import { has } from '../dev-stack.ts';

test('has resolves the required git executable on every supported host', () => {
  expect(has('git')).toBe(true);
});

test('has rejects a command that is not installed', () => {
  expect(has('__forgeax_command_that_does_not_exist__')).toBe(false);
});
