// 统一 agent 命名展示：title=「中文职能·英文名」，sub=灰字英文职能。
// 数据由 server（/api/workbench/agents、/api/bus/plugins）算好挂在 `naming` 上；
// 这里只做读取 + 老 server / 缺字段时的兜底，避免前端各处重复拼格式。

export interface AgentNaming {
  title: string;
  sub: string;
}

export function resolveNaming(a: {
  naming?: AgentNaming | null;
  name?: string;
  displayName?: { zh?: string; en?: string } | string;
  id?: string;
}): AgentNaming {
  if (a.naming && a.naming.title) return a.naming;
  const fallback =
    a.name?.trim() ||
    (typeof a.displayName === 'string'
      ? a.displayName
      : a.displayName?.zh ?? a.displayName?.en) ||
    a.id ||
    '';
  return { title: fallback, sub: '' };
}
