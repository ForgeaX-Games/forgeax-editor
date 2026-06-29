// Shared provider-badge dictionary for chat surfaces (ForgeCard +
// SubAgentCard). Both surfaces tag a completed message/run with the cli
// that produced it via a small pill in the header.
//
// providerBadgeFor() returns a neutral-grey fallback when the id isn't in
// the dict — so a future provider (e.g. 'gemini' registered server-side)
// still gets a usable pill until the dict learns its brand colour. Before
// the fallback was extracted the badge silently disappeared (tick 242).
//
// P3.77 — when the provider id matches a bus cli-provider plugin (registry
// fetched once per page load and module-cached), the pill upgrades to a
// `<span role="button">` that deep-links into the Bus admin panel for that
// plugin (kind=cli-provider solo + row auto-expanded). Reuses the
// pendingBusKindFilter + pendingBusExpandId pipeline already wired for
// Dashboard cells (P3.65/67/68). Renders span-with-role rather than a
// <button> because the parent kc-header / sac-header is already a <button>
// and nested buttons are invalid HTML — same pattern as AgentsPanel pills
// in P3.32. Unregistered ids (or any id while the registry fetch is in
// flight) keep the legacy non-interactive <span>.

import {
  createElement,
  useEffect,
  useState,
  type ReactElement,
  type MouseEvent,
  type KeyboardEvent,
} from 'react';
import { t } from '@/i18n';

export interface ProviderBadge {
  label: string;
  color: string;
  title: string;
}

const PROVIDER_BADGE: Record<string, ProviderBadge> = {
  'forgeax':     { label: 'forgeax',     color: '#9ec5d4', title: 'ForgeaX CLI provider' },
  'claude-code': { label: 'claude-code', color: '#cfa3ff', title: 'Anthropic claude-code CLI provider' },
  'codex':       { label: 'codex',       color: '#7be7c4', title: 'OpenAI Codex CLI provider' },
};

export function providerBadgeFor(id: string): ProviderBadge {
  return PROVIDER_BADGE[id] ?? {
    label: id,
    color: '#888',
    title: `CLI provider: ${id} (no UI badge style registered yet)`,
  };
}

// Module-scope registry of bus cli-provider plugins, keyed by shortId
// (e.g. 'claude-code'). Single fetch on first hook use; subsequent hook
// callers reuse the cached map. /api/bus/plugins?kind=cli-provider is
// session-immutable in the current v1 (plugins load at server boot), so
// no polling needed. Failure → empty map (pill stays non-interactive).
let _cliProviderMap: Map<string, string> | null = null;
let _cliProviderLoad: Promise<void> | null = null;

interface CliProviderItem {
  id: string;
}

// Derive cli-provider shortId (e.g. 'claude-code') from the plugin id
// pattern `@forgeax-plugin/cli-{shortId}`. Server's cliProvider.id slim
// field currently echoes the plugin id rather than the short cli id, so
// we strip the canonical prefix here. Pattern matches the same id-shape
// helpers in Composer.tsx (P2.7d) + Dashboard cells (P3.65/67/68).
const CLI_PLUGIN_PREFIX = '@forgeax-plugin/cli-';

function shortIdFromPluginId(pluginId: string): string | null {
  if (!pluginId.startsWith(CLI_PLUGIN_PREFIX)) return null;
  const short = pluginId.slice(CLI_PLUGIN_PREFIX.length);
  return short.length > 0 ? short : null;
}

function ensureCliProviderMap(): Promise<void> {
  if (_cliProviderMap) return Promise.resolve();
  if (_cliProviderLoad) return _cliProviderLoad;
  _cliProviderLoad = fetch('/api/bus/plugins?kind=cli-provider')
    .then((r) => (r.ok ? r.json() : { items: [] }))
    .then((j: { items?: CliProviderItem[] }) => {
      const m = new Map<string, string>();
      for (const p of j.items ?? []) {
        const short = shortIdFromPluginId(p.id);
        if (short) m.set(short, p.id);
      }
      _cliProviderMap = m;
    })
    .catch(() => { _cliProviderMap = new Map(); });
  return _cliProviderLoad;
}

export function useCliProviderPluginMap(): Map<string, string> | null {
  const [ready, setReady] = useState<boolean>(_cliProviderMap !== null);
  useEffect(() => {
    if (_cliProviderMap) { setReady(true); return; }
    let cancelled = false;
    void ensureCliProviderMap().then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);
  return ready ? _cliProviderMap : null;
}

export function ProviderBadgePill({
  providerId,
  className,
  onBusDeepLink,
}: {
  providerId: string;
  className: string;
  onBusDeepLink?: (pluginId: string) => void;
}): ReactElement {
  const badge = providerBadgeFor(providerId);
  const map = useCliProviderPluginMap();
  const pluginId = map?.get(providerId) ?? null;
  const canDeepLink = !!onBusDeepLink && !!pluginId;

  if (!canDeepLink) {
    return createElement(
      'span',
      {
        className,
        title: badge.title,
        style: { borderColor: badge.color, color: badge.color },
      },
      badge.label,
    );
  }

  const fire = () => onBusDeepLink!(pluginId!);
  return createElement(
    'span',
    {
      className: `${className} is-link`,
      role: 'button',
      tabIndex: 0,
      title: t('providerBadge.clickToBusDetail', { title: badge.title }),
      style: { borderColor: badge.color, color: badge.color },
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        fire();
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.stopPropagation();
        e.preventDefault();
        fire();
      },
    },
    badge.label,
    createElement(
      'span',
      { className: 'provider-badge-arrow', 'aria-hidden': true, key: 'arrow' },
      '→',
    ),
  );
}
