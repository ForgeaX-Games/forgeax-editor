import { describe, expect, it, mock } from 'bun:test';
import { createCommandsRegistry } from './commands';
import { ExtensionConflictError } from './errors';

describe('CommandsRegistry', () => {
  it('executes registered handler and returns its result', async () => {
    const reg = createCommandsRegistry();
    reg.register({ id: 'x.foo', execute: (args) => ({ args }) });
    const r = await reg.execute<{ args: { a: 1 } }>('x.foo', { a: 1 });
    expect(r).toEqual({ args: { a: 1 } });
  });

  it('duplicate id throws ExtensionConflictError', () => {
    const reg = createCommandsRegistry();
    reg.register({ id: 'x.foo', execute: () => {} });
    expect(() => reg.register({ id: 'x.foo', execute: () => {} })).toThrow(ExtensionConflictError);
  });

  it('cleanup returned from register unregisters the command', async () => {
    const reg = createCommandsRegistry();
    const off = reg.register({ id: 'x.foo', execute: () => 42 });
    off();
    await expect(reg.execute('x.foo')).rejects.toThrow(/not found/);
  });

  it('unknown id rejects with "not found"', async () => {
    const reg = createCommandsRegistry();
    await expect(reg.execute('nope')).rejects.toThrow(/not found/);
  });

  it('onDidRegister fires with new id; cleanup returned by onDidRegister removes listener', () => {
    const reg = createCommandsRegistry();
    const seen: string[] = [];
    const off = reg.onDidRegister((id) => seen.push(id));
    reg.register({ id: 'a', execute: () => {} });
    reg.register({ id: 'b', execute: () => {} });
    off();
    reg.register({ id: 'c', execute: () => {} });
    expect(seen).toEqual(['a', 'b']);
  });

  it('when predicate returning false rejects execute', async () => {
    const reg = createCommandsRegistry();
    reg.register({ id: 'gated', when: () => false, execute: () => 1 });
    await expect(reg.execute('gated')).rejects.toThrow(/when/);
  });
});
