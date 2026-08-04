import { describe, expect, test } from 'bun:test';
import {
  matchRule,
  normalizeRules,
  parseRuleString,
  rulesFromPermissionsSetting,
} from './permission-rules';
import { splitShellCommand, stripEnvAssignments } from './shell-split';

describe('parseRuleString', () => {
  test('Tool / Tool(content) / 非法形状', () => {
    expect(parseRuleString('Bash', 'deny')).toEqual({ toolName: 'Bash', behavior: 'deny', source: undefined });
    expect(parseRuleString('Bash(git *)', 'allow')).toEqual({
      toolName: 'Bash',
      content: 'git *',
      behavior: 'allow',
      source: undefined,
    });
    expect(parseRuleString('', 'deny')).toBeNull();
    expect(parseRuleString('Bash(oops', 'deny')).toBeNull(); // 未闭合 → fail-closed 丢弃
  });
});

describe('matchRule — shell 结构感知(E-01 走私防护)', () => {
  const allow = [parseRuleString('Bash(git *)', 'allow')!];
  const deny = [parseRuleString('Bash(rm *)', 'deny')!];

  test('allow Bash(git *) 不覆盖复合命令走私', () => {
    expect(matchRule(allow, 'Bash', { command: 'git status' })).toBeDefined();
    expect(matchRule(allow, 'Bash', { command: 'git status && rm -rf /' })).toBeUndefined();
    expect(matchRule(allow, 'Bash', { command: 'git $(danger)' })).toBeUndefined(); // unsafe → 不成立
  });

  test('deny Bash(rm *) 命中任一子命令 + 剥 env 前缀', () => {
    expect(matchRule(deny, 'Bash', { command: 'echo x && rm -rf /tmp/y' })).toBeDefined();
    expect(matchRule(deny, 'Bash', { command: 'FOO=1 rm -rf /tmp/y' })).toBeDefined();
    expect(matchRule(deny, 'Bash', { command: 'echo rm' })).toBeUndefined();
  });

  test('MCP server 级规则前缀命中', () => {
    const r = [parseRuleString('mcp__fs', 'deny')!];
    expect(matchRule(r, 'mcp__fs__read', {})).toBeDefined();
    expect(matchRule(r, 'mcp__other__read', {})).toBeUndefined();
  });
});

describe('rulesFromPermissionsSetting', () => {
  test('三桶解析 + 非法条目丢弃 + 非法形状安全降级', () => {
    const rs = rulesFromPermissionsSetting({
      deny: ['Bash(rm *)', 42, 'Bad('],
      ask: ['Bash(git push*)'],
      allow: 'not-an-array',
    });
    expect(rs.deny).toHaveLength(1);
    expect(rs.ask).toHaveLength(1);
    expect(rs.allow).toHaveLength(0);
    expect(rs.deny[0].source).toBe('settings.permissions.deny');
    expect(rulesFromPermissionsSetting(null)).toEqual({ deny: [], ask: [], allow: [] });
  });
});

describe('shell-split', () => {
  test('top-level 算子拆分 + 引号保护 + unsafe 侦测', () => {
    expect(splitShellCommand('a && b; c | d').segments).toEqual(['a', 'b', 'c', 'd']);
    expect(splitShellCommand("echo 'a && b'").segments).toEqual(["echo 'a && b'"]);
    expect(splitShellCommand('echo $(x)').unsafe).toBe(true);
    expect(stripEnvAssignments('FOO=1 BAR="x y" rm -rf /')).toBe('rm -rf /');
  });
});

describe('normalizeRules', () => {
  test('缺桶补空(fail-safe)', () => {
    expect(normalizeRules({ deny: [] })).toEqual({ deny: [], ask: [], allow: [] });
    expect(normalizeRules(undefined)).toEqual({ deny: [], ask: [], allow: [] });
  });
});
