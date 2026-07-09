// ActiveModelRoute — the single source of truth for "which model source is the
// chat actually using right now", and the one place that mutation flows through.
//
// Design §12 (adopted revisions) calls for a closed-union ActiveModelRoute from
// which `providerOverride` is DERIVED rather than a second hand-maintained
// field. In this codebase the runtime routing is already decided by two pieces
// of existing state — we do NOT add a third:
//
//   1. store.providerOverride (per-session): null → native forgeax path
//      (POST /api/sessions/:sid/messages); non-null → a CLI driver via
//      /api/cli/chat (claude-code / codex / cursor-agent / codebuddy).
//   2. .env FORGEAX_MODEL: which model the native path resolves (auto-resolver
//      routes by id prefix — claude-* → Anthropic, gpt-* → OpenAI, …).
//
// So the "active source" the Providers panel + onboarding show is a pure
// DERIVATION over (providerOverride, FORGEAX_MODEL), and switching source is a
// single `applyModelRoute` that writes both consistently. No ghost field.

import { useShellStore } from '../../store';
import { getAgentModel, listModels, setAgentModels } from '../model-config';
import { getLastModel } from '../model-prefs';

/** Closed union of model sources the UI can present + switch between. */
export type ModelSource =
  /** BYO OpenAI-compatible key — native path, FORGEAX_MODEL=<vendor id>. */
  | { kind: 'api-key'; model: string }
  /** Local CLI driver — providerOverride=<id>. */
  | { kind: 'cli'; providerId: string };

/**
 * The UI-facing "active source" identifier: 'api-key' | <cli-id> | null
 * (nothing set).
 */
export type ActiveSourceId = 'api-key' | string | null;

const RE_OPENAI = /^(gpt-|o[1-9]|codex-)/i;

/**
 * Derive the active source id purely from the two runtime inputs. Kept a pure
 * function so it can be unit-tested and reused by both the Providers panel and
 * the onboarding readiness gate.
 */
export function deriveActiveSource(
  providerOverride: string | null,
  forgeaxModel: string | null,
): ActiveSourceId {
  // A CLI override always wins — the chat is routed through /api/cli/chat.
  if (providerOverride && providerOverride !== 'forgeax') {
    return providerOverride;
  }
  // Native path: the model id tells us the source.
  const m = (forgeaxModel ?? '').trim();
  if (m && RE_OPENAI.test(m)) return 'api-key';
  // Any native model (claude-*/gemini-*/proxy) — still the "api-key" bucket from
  // the Providers UI's perspective (BYO credential).
  if (m) return 'api-key';
  return null;
}

async function patchEnv(patch: Record<string, string>): Promise<void> {
  const r = await fetch('/api/settings/env', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!r.ok || !j?.ok) {
    throw new Error(j?.error ?? `HTTP ${r.status}`);
  }
}

/**
 * Switch the active model source. Writes the two underlying pieces of state
 * atomically-enough (env then override) so the derived active source lands on
 * the requested value. Returns once persisted.
 *
 *  - api-key → providerOverride=null + FORGEAX_MODEL=<vendor id> (env keys are
 *              saved separately via the Providers EnvFields)
 *  - cli     → providerOverride=<id> (FORGEAX_MODEL untouched — the driver owns
 *              its own model selection)
 */
export async function applyModelRoute(source: ModelSource): Promise<void> {
  const setProviderOverride = useShellStore.getState().setProviderOverride;
  switch (source.kind) {
    case 'api-key':
      await patchEnv({ FORGEAX_MODEL: source.model });
      setProviderOverride(null);
      return;
    case 'cli':
      setProviderOverride(source.providerId);
      return;
  }
}

/** The catalog provider id currently in effect, derived from providerOverride. */
export function currentCatalogProvider(providerOverride: string | null): string | null {
  return providerOverride && providerOverride !== 'forgeax' ? providerOverride : null;
}

/**
 * Reset the ACTIVE agent's model to a catalog's default (first non-hidden entry).
 * This is the shared core of "switch source → land on a model that belongs to the
 * new source", so switching from the chat dropdown OR Settings › Providers behaves
 * identically (the reported drift: Settings changed the route but left the agent
 * pinned to the old provider's model). No-ops when there's no active agent/session
 * (e.g. onboarding init) or the catalog is empty. Returns what it set, or null.
 */
export async function resetActiveAgentModelToProviderDefault(
  catalogProviderId: string | null,
): Promise<{ sid: string; agentPath: string; selected: string } | null> {
  const st = useShellStore.getState();
  const sid = st.activeSid;
  const agentPath = sid ? (st.tabs.find((t) => t.sid === sid)?.agentId ?? null) : null;
  if (!sid || !agentPath) return null;
  const catalog = await listModels(catalogProviderId);
  const nextModel = catalog.find((m) => !m.hidden)?.id ?? catalog[0]?.id;
  if (!nextModel) return null;
  const res = await setAgentModels(sid, agentPath, [nextModel]);
  return { sid, agentPath, selected: res.selected ?? nextModel };
}

/**
 * Reset EVERY open session's agent model to a catalog's default.
 *
 * `providerOverride` is GLOBAL (one value for the whole app), so switching it
 * re-routes ALL sessions through the new provider — but each session's
 * agent.json still pins the OLD provider's model id, which may not exist in the
 * new provider's catalog. The product requirement is therefore: switching the
 * provider in Settings resets the current model of ALL active sessions to the
 * new provider's default (not just the focused one). We compute the default
 * once (provider-scoped) and write it into each open tab's agent.json. Returns
 * the model set + how many sessions were updated, or null when nothing to do.
 */
export async function resetOpenSessionsModelToProviderDefault(
  catalogProviderId: string | null,
): Promise<{ selected: string; count: number } | null> {
  const st = useShellStore.getState();
  const targets = st.tabs
    .map((t) => ({ sid: t.sid, agentPath: t.agentId }))
    .filter((x): x is { sid: string; agentPath: string } => !!x.sid && !!x.agentPath);
  if (targets.length === 0) return null;
  const catalog = await listModels(catalogProviderId);
  const nextModel = catalog.find((m) => !m.hidden)?.id ?? catalog[0]?.id;
  if (!nextModel) return null;
  let count = 0;
  for (const { sid, agentPath } of targets) {
    try {
      await setAgentModels(sid, agentPath, [nextModel]);
      count++;
    } catch (e) {
      // Best-effort per session — one bad agent.json must not abort the rest.
      console.warn('[model-route] reset session model failed', { sid, agentPath, err: e });
    }
  }
  return count > 0 ? { selected: nextModel, count } : null;
}

/**
 * On SESSION SWITCH: conform the switched-to session's model to the currently
 * ACTIVE provider (Settings › Providers is the single global provider setting;
 * the in-chat switcher is hidden). "Does this session's provider match the
 * active provider?" is answered by CATALOG MEMBERSHIP — a session whose
 * agent.json model isn't in the active provider's catalog was last touched
 * under a DIFFERENT provider (e.g. switching game loads that game's disk
 * sessions, which the last provider-switch reset never reached).
 *
 *   • mismatch → snap the session's model to this provider's last HAND-PICKED
 *     model (model-prefs), else its catalog default (first non-hidden);
 *   • match (model already in the active catalog) → leave it untouched
 *     ("同 provider 就不管").
 *
 * Best-effort + returns null on no-op: an empty catalog, a missing model, or
 * any IO failure must never block the session switch. Returns the model set on
 * a mismatch so the caller can repaint immediately if it wants.
 */
export async function reconcileSessionModelToActiveProvider(
  sid: string,
  agentPath: string,
): Promise<{ selected: string } | null> {
  const catalogProviderId = currentCatalogProvider(useShellStore.getState().providerOverride);
  const catalog = await listModels(catalogProviderId).catch(() => null);
  if (!catalog || catalog.length === 0) return null;

  const cur = await getAgentModel(sid, agentPath).catch(() => null);
  const currentId = cur?.selected ?? null;
  // Same provider — the session's model is a member of the active catalog. Leave it.
  if (currentId && catalog.some((m) => m.id === currentId)) return null;

  // Mismatch — prefer this provider's last hand-picked model, else its default.
  const remembered = getLastModel(catalogProviderId);
  const rememberedOk = !!remembered && catalog.some((m) => m.id === remembered && !m.hidden);
  const next = rememberedOk ? remembered! : (catalog.find((m) => !m.hidden)?.id ?? catalog[0]?.id);
  if (!next) return null;
  try {
    await setAgentModels(sid, agentPath, [next]);
    return { selected: next };
  } catch (e) {
    console.warn('[model-route] reconcile session model failed', { sid, agentPath, err: e });
    return null;
  }
}

/**
 * Is there a usable model path RIGHT NOW? Used by the chat composer to
 * intercept a first send with no configured model (design §11 first-chat).
 *
 * Deliberately PRECISE + fail-open: we only return false for the one
 * unambiguous "definitely no path" case so a working setup is never wrongly
 * blocked (GET /api/settings can't see every credential, e.g. LiteLLM proxy):
 *   - native path + no model at all + no visible OpenAI/Anthropic credential
 * Any CLI override, any visible key, or any model id → ready.
 */
export async function checkModelReady(): Promise<boolean> {
  const providerOverride = useShellStore.getState().providerOverride;
  if (providerOverride && providerOverride !== 'forgeax') return true; // CLI driver path

  try {
    const r = await fetch('/api/settings');
    if (!r.ok) return true; // fail-open on infra hiccup — never block on our own error
    const j = (await r.json()) as { env?: Record<string, string | null> };
    const env = j.env ?? {};
    const hasKey = !!(env.LITELLM_PROXY_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
    if (hasKey) return true;
    const model = (env.FORGEAX_MODEL ?? '').trim();
    // A model id is set → assume a proxy/vendor path resolves it.
    if (model) return true;
    return false;
  } catch {
    return true; // fail-open
  }
}
