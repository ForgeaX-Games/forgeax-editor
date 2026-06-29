/** ADR-0019 — UI 端镜像 server `AgentAvatarRules` 结构. server 端定义在
 *  packages/types/src/agent.ts; interface 不直接依赖 server, 这里再镜像一份, 字段
 *  名一一对应. */

export type AgentAvatarEvent =
  | 'run_start'
  | 'reasoning_active'
  | 'speaking_active'
  | 'tool_active'
  | 'sub_agent_active'
  | 'production_signal'
  | 'metabolism_signal'
  | 'error_signal'
  | 'media_active'
  | 'run_end';

export interface AgentAvatarState {
  state: string;
  url: string;
  loop: boolean;
  fadeInMs: number;
  onEnd?: string;
  onEndAfterMs?: number;
}

export interface AgentAvatarRules {
  default: string;
  fallback: string;
  events: Partial<Record<AgentAvatarEvent, string>>;
  priority: Record<string, number>;
  states: Record<string, AgentAvatarState>;
}
