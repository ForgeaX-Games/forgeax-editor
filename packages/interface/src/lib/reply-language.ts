/**
 * Agent reply-language resolution.
 *
 * Reply language follows the interface locale (Settings → Language). The agent
 * is asked to answer in the same language as the UI chrome.
 */

import { getLocale } from '@/i18n';

export type ReplyLang = 'en' | 'zh';

/** Resolve the reply language for a turn — always the current UI locale. */
export function resolveReplyLanguage(_userText: string): ReplyLang {
  return getLocale();
}
