// 统一 agent 命名展示：title=「中文职能·英文名」，sub=灰字英文职能（英文模式下反转）。
// 数据由 server（/api/workbench/agents、/api/bus/plugins）算好挂在 `naming` 上；
// 这里只做读取 + 老 server / 缺字段时的兜底，避免前端各处重复拼格式。

import { getLocale, type Locale } from '@/i18n';
import { pickLang } from './bus-api';

export interface AgentNaming {
  title: string;
  sub: string;
}

export function resolveNaming(
  a: {
    naming?: AgentNaming | null;
    name?: string;
    displayName?: { zh?: string; en?: string } | string;
    id?: string;
  },
  locale?: Locale,
): AgentNaming {
  const lang = locale ?? getLocale();
  if (a.naming?.title) {
    // Server already localizes naming when /api/workbench/agents?lang=en.
    if (lang === 'en' && !/[\u4e00-\u9fff]/.test(a.naming.title)) return a.naming;
    if (lang === 'zh') return a.naming;
    const { title, sub } = a.naming;
    if (sub) return { title: sub, sub: title.includes('·') ? title.split('·')[0]! : '' };
    return a.naming;
  }
  const fallback =
    a.name?.trim() ||
    pickLang(a.displayName ?? '', lang, '') ||
    a.id ||
    '';
  return { title: fallback, sub: '' };
}
