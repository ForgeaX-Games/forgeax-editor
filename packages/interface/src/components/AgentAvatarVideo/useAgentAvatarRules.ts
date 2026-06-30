import { useEffect, useState } from 'react';
import {
  ensureAvatarRulesLoaded,
  getAvatarRulesSnapshot,
  subscribeAvatarRules,
} from './avatar-registry';
import type { AgentAvatarRules } from './types';

/** 拿单个 agent 的 avatarRules; 还在 fetch 时返回 null. */
export function useAgentAvatarRules(agentId: string | null | undefined): AgentAvatarRules | null {
  const [snap, setSnap] = useState<Record<string, AgentAvatarRules> | null>(getAvatarRulesSnapshot);
  useEffect(() => {
    if (snap === null) void ensureAvatarRulesLoaded();
    return subscribeAvatarRules(() => setSnap(getAvatarRulesSnapshot()));
  }, [snap]);
  if (!agentId || !snap) return null;
  // ADR-0019 §Decision §4: legacy "forge" 视觉上是 Arin → server 端 workbench API
  // 已经做了 alias 注入, 这里不再特判. agent path 形如 "forge/iori" 取末段.
  const tail = agentId.split('/').pop() ?? agentId;
  return snap[tail] ?? snap[agentId] ?? null;
}
