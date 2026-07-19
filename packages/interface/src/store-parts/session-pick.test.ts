import { describe, expect, it } from 'bun:test';
import { mostRecentSid, pickActiveSid } from './session-pick';

describe('mostRecentSid', () => {
  it('returns null for empty list', () => {
    expect(mostRecentSid([])).toBeNull();
  });

  it('picks the highest lastActivityAt, not list order', () => {
    // server /api/sessions 按 readdir 顺序返回,老会话可能排前面。
    expect(mostRecentSid([
      { sid: 'old', lastActivityAt: 100 },
      { sid: 'new', lastActivityAt: 200 },
    ])).toBe('new');
    expect(mostRecentSid([
      { sid: 'new', lastActivityAt: 200 },
      { sid: 'old', lastActivityAt: 100 },
    ])).toBe('new');
  });

  it('treats missing lastActivityAt as 0', () => {
    expect(mostRecentSid([
      { sid: 'no-ts' },
      { sid: 'has-ts', lastActivityAt: 1 },
    ])).toBe('has-ts');
  });

  it('falls back to the first entry when nothing has activity', () => {
    expect(mostRecentSid([{ sid: 'a' }, { sid: 'b' }])).toBe('a');
  });
});

describe('pickActiveSid', () => {
  const tabs = [
    { sid: 'old', lastActivityAt: 100 },
    { sid: 'new', lastActivityAt: 200 },
  ];

  it('keeps the persisted sid when it is still in the list', () => {
    // 用户上次明确停留在 old(哪怕不是最近活跃的)—— 刷新后应该回到 old。
    expect(pickActiveSid(tabs, 'old')).toBe('old');
  });

  it('falls back to most recent when the persisted sid is gone', () => {
    // persisted 指向已删除的 session(如清理过的空会话)→ 回落该 game 最近对话。
    expect(pickActiveSid(tabs, 'deleted')).toBe('new');
  });

  it('falls back to most recent when nothing is persisted', () => {
    expect(pickActiveSid(tabs, null)).toBe('new');
  });

  it('returns null for empty list', () => {
    expect(pickActiveSid([], 'anything')).toBeNull();
  });
});
