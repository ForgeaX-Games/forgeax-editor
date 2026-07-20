// OnboardingController — faithful port of first-run-onboarding-prototype onto
// the live shell (design §11). Phases:
//
//   welcome  → language + connect-a-model (mutually exclusive API Key / local CLI;
//              Next probes the selected path) → 2s auto-advance on success.
//   project  → root dir + new / open / sample project cards → enter home.
//   home     → TourOverlay coach marks over the LIVE shell, then a first-chat
//              nudge near the composer. Completing / skipping ends onboarding.
//
// Runtime state (open sub-modal, check result, countdown) is ephemeral; only
// the phase + milestone flags persist (Onboarding/types).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation, changeLanguage, getLocale, type Locale } from '@/i18n';
import { useShellStore } from '../../store';
import { useHost } from '../../core/app-shell';
import { applyModelRoute } from '../../lib/model-route';
import { listModelsWithLive } from '../../lib/model-config';
import { activateWorkspace } from '../../lib/workspace-activate';
import { fetchCliProviders, type CliProviderInfo } from '../../lib/cli-providers';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TourOverlay, type TourStep } from '../TourOverlay';
import { APP_EVENTS } from '../../lib/storageKeys';
import { loadOnboarding, saveOnboarding, type OnboardingPhase, PHASE_ORDER } from './types';
import {
  interpretLiveCatalogProbe,
  needsConnectSelection,
  validateApiKeyFields,
  type ConnectSelected,
} from './connect-selection';
import { isUserExistingGame, resolveProjectName, toGameSlug } from './project-name';
import { latchTourShellDefaults, prepareTourShell } from './prepareTourShell';
import { loadWorkbenchList, subscribeWorkbenchList } from '../../lib/workbenches';
import './Onboarding.css';

/** Native OS folder dialog via the local Studio server (same machine as the UI). */
async function pickDirectoryNative(): Promise<string | null> {
  const r = await fetch('/api/fs/pick-directory', { method: 'POST' });
  const j = (await r.json().catch(() => null)) as {
    ok?: boolean;
    cancelled?: boolean;
    path?: string;
    error?: string;
  } | null;
  if (j?.cancelled) return null;
  if (!r.ok || !j?.ok || !j.path) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j.path;
}

type CheckResult = '' | 'ok' | 'fail';
// A local-CLI driver id. Not a closed union: the connectable set is whatever
// /api/cli/health reports (claude-code / codex / cursor-agent / codebuddy / …),
// so hardcoding literals here would silently drop newly-registered kernels
// (that was the codebuddy-missing bug). Kept as a named alias for readability.
type CliId = string;

/** A built-in game usable as a first-run template (GET /api/workbench/templates). */
interface TemplateInfo { slug: string; name: string }

/** A game already present in the active workspace (GET /api/workbench/games).
 *  Non-empty ⇒ the project step ALSO offers "open an existing project" — a
 *  returning user (or a freshly-pulled repo that ships games) enters home
 *  directly instead of being forced through create. */
interface ExistingGame { slug: string; name: string }

// ── Pending project intent (survives the activate→reload root switch) ──────────
// Creating the first project under a root that ISN'T the running workspace root
// (e.g. dev cwd = repo, but the user wants ~/ForgeaxProjects) requires switching
// FORGEAX_PROJECT_ROOT — which the server does via a full-page reload. We stash
// the intent here BEFORE activating, then the freshly-booted controller resumes
// it (now under the correct root) and creates the game. Same-root creates skip
// all of this and never touch localStorage.
type ProjectIntent =
  | { kind: 'new'; root: string; name: string }
  | { kind: 'template'; root: string; name: string; template: string }
  | { kind: 'open'; root: string; path: string };

type PendingIntent = ProjectIntent & { at: number };

/** Drop pending intents older than this — leftover entries from failed/abandoned
 *  root switches were auto-resuming on every project-step mount and painting
 *  ghost errors ("already exists" / "not a game folder") with no user action. */
const PENDING_TTL_MS = 90_000;

const PENDING_KEY = 'forgeax.onboarding.pendingProject';
function loadPending(): PendingIntent | null {
  try {
    const s = localStorage.getItem(PENDING_KEY);
    if (!s) return null;
    const p = JSON.parse(s) as Partial<PendingIntent> & { kind?: string };
    if (!p || !p.kind) { clearPending(); return null; }
    // Legacy payloads without `at` are treated as stale (pre-TTL bug source).
    if (typeof p.at !== 'number' || Date.now() - p.at > PENDING_TTL_MS) {
      clearPending();
      return null;
    }
    return p as PendingIntent;
  } catch { return null; }
}
function savePending(p: ProjectIntent): void {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, at: Date.now() })); } catch { /* ignore */ }
}
function clearPending(): void { try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ } }

/** Map raw server errors to onboarding copy (keep unknown messages as-is). */
function formatProjectError(raw: string, t: (key: string) => string): string {
  if (/not a game folder/i.test(raw)) return t('onboarding.project.errNotGame');
  return raw;
}

/** True when `root` (a `~/…` or absolute path) is the currently-active workspace
 *  root — compared against BOTH the friendly (`~/…`) and absolute server forms. */
async function isActiveRoot(root: string): Promise<boolean> {
  try {
    const j = (await fetch('/api/workspaces/active').then((r) => r.json())) as { absPath?: string; path?: string };
    return root === j.path || root === j.absPath;
  } catch { return false; }
}

// Install-doc links, keyed by driver id. Optional lookup: a driver reported by
// /api/cli/health but absent here simply renders without a "how to install" link.
const CLI_LINKS: Record<string, { name: string; url: string }> = {
  'claude-code': { name: 'the reference agent CLI', url: 'https://code.claude.com/docs/en/setup' },
  codex: { name: 'Codex CLI', url: 'https://developers.openai.com/codex/quickstart' },
  'cursor-agent': { name: 'Cursor CLI', url: 'https://cursor.com/docs/cli/installation' },
  codebuddy: { name: 'a peer agent CLI CLI', url: 'https://www.codebuddy.ai/cli' },
};

// The native ForgeaX kernel (forgeax-core / forgeax) is registered in the shared
// kernel registry, so /api/cli/health surfaces it too — but it is NOT a
// connectable "Local CLI" (it's the API-key native path). Mirror
// Settings › Providers and drop it from the Local CLI dropdown.
const NATIVE_KERNEL_IDS = new Set(['forgeax-core', 'forgeax']);

// Seed list painted INSTANTLY (before /api/cli/health resolves) so all rows show
// up immediately in a "checking…" state rather than an empty box. It must be the
// COMPLETE known driver set (incl. codebuddy) — an incomplete seed was the "3 now,
// codebuddy later" bug. It is only a paint-fast optimism: once health returns it
// becomes the source of truth (below), so a future driver it doesn't list still
// appears, and per-row status is always live.
const SEED_CLI_IDS: CliId[] = ['claude-code', 'codex', 'cursor-agent', 'codebuddy'];

/** Local-CLI driver ids to offer. Before health lands: the complete seed (all
 *  rows visible, each "checking"). After: derived LIVE from /api/cli/health with
 *  the native path dropped — authoritative, so drivers can be added/removed and
 *  each row's dot reflects real reachability. */
function cliIdsFrom(providers: CliProviderInfo[] | null): CliId[] {
  if (!providers) return SEED_CLI_IDS;
  return providers.filter((p) => !NATIVE_KERNEL_IDS.has(p.id)).map((p) => p.id);
}

// Fallback model pinned when the user activates the API-key source in onboarding
// without a finer choice — mirrors Settings › Providers (SectionsRegister's
// `apiModel` fallback) so the active-source derivation resolves to 'api-key'
// and the native path has a concrete model to call.
const OB_API_KEY_DEFAULT_MODEL = 'gpt-4o-mini';

type CliStatusKind = 'loading' | 'ok' | 'down' | 'unknown';
const CLI_STATUS_COLOR: Record<CliStatusKind, string> = {
  loading: 'var(--ob-text-3)',
  ok: 'var(--ob-ok, #3fa266)',
  down: 'var(--ob-err, #e04a5a)',
  unknown: 'var(--ob-text-3)',
};

/** Map a CLI id against live health into a connectable-status token. */
function cliStatus(id: CliId, providers: CliProviderInfo[] | null): CliStatusKind {
  if (!providers) return 'loading';
  const found = providers.find((p) => p.id === id);
  if (!found) return 'unknown'; // not reported by /api/cli/health → not installed
  return found.health.ok ? 'ok' : 'down';
}

/** Dropdown option: id + a colored status dot + a "connectable" label, so the
 *  user can tell which local CLI is actually usable before picking it. */
function CliOptionLabel({ t, id, providers }: { t: TFn; id: CliId; providers: CliProviderInfo[] | null }) {
  const kind = cliStatus(id, providers);
  // Prefer the health-reported display name (e.g. "a peer agent CLI CLI"), then the
  // install-doc table, then the raw id — so the row reads human, not slug.
  const label = providers?.find((p) => p.id === id)?.displayName ?? CLI_LINKS[id]?.name ?? id;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: CLI_STATUS_COLOR[kind], flexShrink: 0 }} />
      <span>{label}</span>
      <span className="fx-ob-tiny fx-ob-muted">{t(`onboarding.connect.cliStatus.${kind}`)}</span>
    </span>
  );
}

async function patchEnv(patch: Record<string, string>): Promise<void> {
  const r = await fetch('/api/settings/env', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!r.ok || !j?.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
}

export function OnboardingController() {
  const { t } = useTranslation();
  const host = useHost();
  const openOverlay = useShellStore((s) => s.openOverlay);
  const switchGame = useShellStore((s) => s.switchGame);

  const [phase, setPhaseState] = useState<OnboardingPhase>(() => loadOnboarding().phase);
  const [lang, setLang] = useState<Locale>(() => getLocale());

  // ── welcome: connect-a-model runtime ──
  const [selected, setSelected] = useState<ConnectSelected>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [cli, setCli] = useState<CliId>('claude-code');
  // Live health of local CLI drivers, keyed by provider id — drives the
  // per-option "connectable" status inside the CLI dropdown. Fetched lazily the
  // first time the CLI section is expanded (the endpoint live-checks each CLI).
  const [cliProviders, setCliProviders] = useState<CliProviderInfo[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult>('');
  const [checkFailMsg, setCheckFailMsg] = useState<React.ReactNode>('');
  const [countdown, setCountdown] = useState<number | null>(null);
  const cdRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── project runtime (§14 Model B: second step = pick/create a game under the
  // workspace root). `projRoot` IS the workspace dir (default ~/ForgeaxProjects,
  // changeable via 更改); a project ≡ a game named <projName> in
  // <projRoot>/.forgeax/games/. When projRoot ≠ the running root, create switches
  // the root first (activate + reload + resume). ──
  const [projRoot, setProjRoot] = useState('~/ForgeaxProjects');
  const [projName, setProjName] = useState('');
  const [tmplOpen, setTmplOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [tmplSlug, setTmplSlug] = useState<string | null>(null);
  const [projBusy, setProjBusy] = useState(false);
  // Which action is in-flight — drives a specific "creating…/copying…/opening…"
  // loading banner so the (possibly multi-second) server-side copy isn't a
  // silent freeze followed by an abrupt jump to home.
  const [projBusyKind, setProjBusyKind] = useState<PendingIntent['kind'] | null>(null);
  const [projErr, setProjErr] = useState<string | null>(null);
  const resumedRef = useRef(false);

  // ── home runtime ──
  // Resume from persisted milestones: a returning user who already finished the
  // tour must NOT see it again on reload. The first-chat hint now lives in the
  // chat empty state (ChatPanel), not here.
  const [tourIdx, setTourIdx] = useState(0);
  const [tourActive, setTourActive] = useState(() => !loadOnboarding().done.tour);

  // Scene tab + default dock layout so tour anchors (sidebar/preview/chat) exist.
  // Re-apply when workbench list notifies with a non-scene activeId — home mount
  // races ProjectSwitcher.setCurrentProject, which can revive a stale 'ai' tab
  // from the real project namespace after our first prepare.
  useEffect(() => {
    if (phase !== 'home' || !tourActive) return;
    prepareTourShell(host);
    return subscribeWorkbenchList(() => {
      if (loadWorkbenchList().activeId === 'scene') return;
      prepareTourShell(host);
    });
  }, [phase, tourActive, host]);

  const setPhase = useCallback((p: OnboardingPhase) => {
    setPhaseState(p);
    const prev = loadOnboarding();
    saveOnboarding({ ...prev, phase: p });
    // Notify the shell gate (App.useOnboardingPhase) so it can mount/unmount the
    // full shell as we move between init (welcome/project) and layout (home).
    window.dispatchEvent(new CustomEvent(APP_EVENTS.onboardingChanged));
  }, []);

  const clearCountdown = () => { if (cdRef.current) { clearInterval(cdRef.current); cdRef.current = null; } };
  const resetCheck = useCallback(() => {
    clearCountdown();
    setChecking(false);
    setCheckResult('');
    setCheckFailMsg('');
    setCountdown(null);
  }, []);

  useEffect(() => () => clearCountdown(), []);

  // Prefetch local CLI health on mount (NOT lazily on card-open): the probe
  // live-checks every driver binary and takes a few seconds, so firing it while
  // the user is still reading the welcome screen means the dropdown is already
  // correct + complete (incl. codebuddy) by the time they expand the CLI card —
  // no stale-then-mutate flash.
  useEffect(() => {
    if (cliProviders) return;
    let cancelled = false;
    fetchCliProviders()
      .then(({ providers }) => {
        if (cancelled) return;
        setCliProviders(providers);
        // Correct the default selection once the live set is known: if the
        // preset (claude-code) isn't among the connectable drivers this
        // machine reports, fall back to the first one so the dropdown never
        // shows a value that has no option row.
        const ids = cliIdsFrom(providers);
        if (ids.length > 0 && !ids.includes(cli)) setCli(ids[0]!);
      })
      .catch(() => { if (!cancelled) setCliProviders([]); });
    return () => { cancelled = true; };
  }, [cliProviders, cli]);

  const connectedList = useCallback((): string[] => {
    if (selected === 'key') return [t('onboarding.connected.key')];
    if (selected === 'cli') return [t('onboarding.connected.cli', { cli })];
    return [];
  }, [selected, cli, t]);

  const beginCountdown = useCallback(() => {
    setCountdown(2);
    cdRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c === null) return null;
        if (c <= 1) { clearCountdown(); resetCheck(); setPhase('project'); return null; }
        return c - 1;
      });
    }, 1000);
  }, [resetCheck, setPhase]);

  const runCheck = useCallback(async () => {
    if (needsConnectSelection(selected)) {
      setChecking(false);
      setCheckResult('fail');
      setCheckFailMsg(t('onboarding.check.failNeedSelect'));
      return;
    }
    resetCheck();
    setChecking(true);
    try {
      if (selected === 'key') {
        if (validateApiKeyFields(baseUrl, apiKey) === 'empty') {
          setChecking(false);
          setCheckResult('fail');
          setCheckFailMsg(t('onboarding.check.failEmpty'));
          return;
        }
        const url = baseUrl.trim();
        const key = apiKey.trim();
        // Align with Settings › Providers: live catalog + llm-gateway read
        // LITELLM_PROXY_*, and forgeax-core speaks Anthropic protocol against
        // ANTHROPIC_* (mirrored on save). OPENAI_* still set for gpt-* routing.
        await patchEnv({
          OPENAI_BASE_URL: url,
          OPENAI_API_KEY: key,
          LITELLM_PROXY_BASE_URL: url,
          LITELLM_PROXY_KEY: key,
          ANTHROPIC_BASE_URL: url,
          ANTHROPIC_API_KEY: key,
        });
        // Gate on LIVE /v1/models only — list_models falls back to disk catalog
        // when live fails, so a bare listModels() would always "succeed".
        const { live } = await listModelsWithLive(null);
        const probe = interpretLiveCatalogProbe(live);
        if (!probe.ok) {
          setChecking(false);
          setCheckResult('fail');
          setCheckFailMsg(t('onboarding.check.failLive'));
          return;
        }
        try {
          const { refreshAllModelCatalogs } = await import('../ModelPicker/useModelCatalog');
          await refreshAllModelCatalogs();
        } catch { /* best-effort UI cache refresh */ }
        await applyModelRoute({ kind: 'api-key', model: OB_API_KEY_DEFAULT_MODEL });
        setChecking(false);
        setCheckResult('ok');
        beginCountdown();
        return;
      }

      // selected === 'cli'
      let ok = false;
      try {
        const { providers } = await fetchCliProviders(true);
        ok = !!providers.find((p) => p.id === cli)?.health.ok;
      } catch {
        ok = false;
      }
      if (ok) {
        await applyModelRoute({ kind: 'cli', providerId: cli });
        setChecking(false);
        setCheckResult('ok');
        beginCountdown();
      } else {
        setChecking(false);
        setCheckResult('fail');
        const lk = CLI_LINKS[cli];
        setCheckFailMsg(
          lk ? (
            <>
              {t('onboarding.check.failCli', { cli })}{' '}
              <a href={lk.url} target="_blank" rel="noopener noreferrer">{lk.name}</a>
            </>
          ) : (
            t('onboarding.check.failCli', { cli })
          ),
        );
      }
    } catch (e) {
      setChecking(false);
      setCheckResult('fail');
      setCheckFailMsg((e as Error).message || t('onboarding.check.fail'));
    }
  }, [selected, resetCheck, baseUrl, apiKey, cli, beginCountdown, t]);

  // §14: there is NO "skip to home" — layout (home) is entered ONLY after a
  // project is initialized (createGame / openGameDir → enterHomeWith). The
  // welcome step's "skip" only skips model-connect and lands on `project`.
  const skipConnect = useCallback(() => { resetCheck(); setPhase('project'); }, [resetCheck, setPhase]);

  // Show the REAL current workspace root (WYSIWYG) instead of a hardcoded
  // ~/ForgeaxProjects placeholder — the displayed path MUST match where a project
  // will actually land. Fetched once on mount; after a root switch + reload this
  // re-reads the now-active root. `更改` overrides it thereafter (runs once).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspaces/active')
      .then((r) => r.json() as Promise<{ path?: string; absPath?: string }>)
      .then((j) => { const p = j.path ?? j.absPath; if (!cancelled && p) setProjRoot(p); })
      .catch(() => { /* keep default */ });
    return () => { cancelled = true; };
  }, []);

  // Lazily load the built-in templates the first time the template modal opens.
  useEffect(() => {
    if (!tmplOpen || templates) return;
    let cancelled = false;
    fetch('/api/workbench/templates')
      .then((r) => r.json() as Promise<{ templates?: TemplateInfo[] }>)
      .then((j) => { if (!cancelled) setTemplates(j.templates ?? []); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [tmplOpen, templates]);

  // Games already in the ACTIVE workspace root (mtime-sorted server-side).
  // Fetched once on mount; drives the "open an existing project" section so a
  // workspace that already has games never forces a create (§14 amendment:
  // opening an existing game IS a valid init — enterHomeWith reuses the same
  // pin + enter path as create/link). Filter out the `default` session stub so
  // an empty workspace does not show a fake "已有项目" row.
  const [existingGames, setExistingGames] = useState<ExistingGame[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/workbench/games')
      .then((r) => r.json() as Promise<{ games?: ExistingGame[] }>)
      .then((j) => {
        if (cancelled) return;
        setExistingGames((j.games ?? []).filter((g) => isUserExistingGame(g.slug)));
      })
      .catch(() => { if (!cancelled) setExistingGames([]); });
    return () => { cancelled = true; };
  }, []);

  // After create/link the game is server-side active; switchGame pins it
  // client-side + auto-creates a first session, then we enter home (shell mounts
  // fresh and reads the active game — no full reload needed for the game step).
  const enterHomeWith = useCallback(async (slug: string) => {
    if (slug) { try { await switchGame(slug); } catch { /* pin best-effort */ } }
    // Latch Scene + default layout intent before shell mounts (onReady race).
    if (!loadOnboarding().done.tour) latchTourShellDefaults();
    setPhase('home');
  }, [switchGame, setPhase]);

  // Open a game that already exists in the active root: no create, no link —
  // just pin + enter home. Reuses the 'open' busy label ("opening…").
  const openExisting = useCallback(async (slug: string) => {
    setProjBusy(true);
    setProjBusyKind('open');
    setProjErr(null);
    try {
      await enterHomeWith(slug);
    } catch (e) {
      setProjErr((e as Error).message);
      setProjBusy(false);
      setProjBusyKind(null);
    }
  }, [enterHomeWith]);

  // Do the actual game create/link. Assumes the workspace root is ALREADY correct
  // (either it matched projRoot, or we've activated + reloaded into it). Throws on
  // failure so the caller can surface the error.
  const execIntent = useCallback(async (intent: ProjectIntent) => {
    if (intent.kind === 'open') {
      const r = await fetch('/api/workbench/games/link', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: intent.path }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string; slug?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      clearPending();
      await enterHomeWith(j.slug ?? '');
      return;
    }
    const slug = toGameSlug(intent.name);
    const r = await fetch('/api/workbench/games', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, name: intent.name.trim() || slug, ...(intent.kind === 'template' ? { template: intent.template } : {}) }),
    });
    const j = (await r.json()) as { ok?: boolean; error?: string; slug?: string };
    if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    clearPending();
    await enterHomeWith(j.slug ?? slug);
  }, [enterHomeWith]);

  // Entry point for all three project actions. Ensures the workspace root equals
  // projRoot first: if it already is, create immediately (no reload); otherwise
  // stash the intent, switch the root (activate → reload), and let the reloaded
  // controller resume it (see the resume effect below).
  const startAction = useCallback(async (intent: ProjectIntent) => {
    let next = intent;
    if (intent.kind !== 'open') {
      const existing = (existingGames ?? []).map((g) => g.slug);
      const resolved = resolveProjectName(intent.name, existing);
      next = { ...intent, name: resolved.name };
    }
    setProjBusy(true);
    setProjBusyKind(next.kind);
    setProjErr(null);
    try {
      if (await isActiveRoot(next.root)) {
        await execIntent(next);
        return;
      }
      // Root switch needed — persist BEFORE activating (activate reloads the page).
      savePending(next);
      await activateWorkspace({ path: next.root, initIfMissing: true, scaffold: false });
      window.location.reload();
    } catch (e) {
      clearPending();
      setProjErr(formatProjectError((e as Error).message, t));
      setProjBusy(false);
      setProjBusyKind(null);
    }
  }, [execIntent, existingGames, t]);

  // Resume a pending intent after the activate→reload root switch. Runs once when
  // the controller mounts at the project phase with a stashed intent whose root
  // is now the active one.
  useEffect(() => {
    if (phase !== 'project' || resumedRef.current) return;
    const pending = loadPending();
    if (!pending) return;
    resumedRef.current = true;
    setProjBusy(true);
    setProjBusyKind(pending.kind);
    void (async () => {
      try {
        if (!(await isActiveRoot(pending.root))) { clearPending(); setProjBusy(false); setProjBusyKind(null); return; }
        await execIntent(pending);
      } catch (e) {
        clearPending();
        const msg = (e as Error).message ?? '';
        // Create already succeeded on a prior attempt (or the slug was taken
        // before resume). Swallow — otherwise remounting the project step with
        // a stale pending intent paints a ghost ".forgeax/games/… already exists"
        // error even though the user did nothing this visit.
        if (/already exists/i.test(msg)) {
          setProjBusy(false);
          setProjBusyKind(null);
          return;
        }
        setProjErr(formatProjectError(msg, t));
        setProjBusy(false);
        setProjBusyKind(null);
      }
    })();
  }, [phase, execIntent, t]);

  const pickProjRoot = useCallback(async () => {
    try {
      const path = await pickDirectoryNative();
      if (!path) return;
      setProjRoot(path);
      if (projErr) setProjErr(null);
      // Path only — do NOT activate/reload here. Workspace switch + create happen
      // when the user clicks 新建/模板/打开. Existing-games list is for the ACTIVE
      // root; refresh it if the pick matches, otherwise hide until create switches.
      if (await isActiveRoot(path)) {
        try {
          const r = await fetch('/api/workbench/games');
          const j = (await r.json()) as { games?: ExistingGame[] };
          setExistingGames((j.games ?? []).filter((g) => isUserExistingGame(g.slug)));
        } catch {
          setExistingGames([]);
        }
      } else {
        setExistingGames([]);
      }
    } catch (e) {
      setProjErr((e as Error).message);
    }
  }, [projErr]);

  const pickOpenDir = useCallback(async () => {
    try {
      const path = await pickDirectoryNative();
      if (!path) return;
      await startAction({ kind: 'open', root: projRoot, path });
    } catch (e) {
      setProjErr((e as Error).message);
    }
  }, [projRoot, startAction]);

  const onLang = (next: Locale) => { setLang(next); changeLanguage(next); };

  const TOUR_STEPS: TourStep[] = [
    { anchorId: 'sidebar', anchor: t('onboarding.tour.sidebar.anchor'), body: t('onboarding.tour.sidebar.body') },
    { anchorId: 'preview', anchor: t('onboarding.tour.preview.anchor'), body: t('onboarding.tour.preview.body') },
    { anchorId: 'chat', anchor: t('onboarding.tour.chat.anchor'), body: t('onboarding.tour.chat.body') },
    { anchorId: 'tb-left', anchor: t('onboarding.tour.tbLeft.anchor'), body: t('onboarding.tour.tbLeft.body') },
    { anchorId: 'tb-center', anchor: t('onboarding.tour.tbCenter.anchor'), body: t('onboarding.tour.tbCenter.body') },
    { anchorId: 'tb-right', anchor: t('onboarding.tour.tbRight.anchor'), body: t('onboarding.tour.tbRight.body') },
  ];

  // Tour is the last onboarding-owned step; the first-chat hint lives in the
  // chat empty state. Mark the tour done and go inert (phase → 'done'), then
  // notify the chat so its hint can appear this session (no reload needed).
  const endTour = useCallback(() => {
    setTourActive(false);
    const prev = loadOnboarding();
    saveOnboarding({ ...prev, phase: 'done', done: { ...prev.done, tour: true } });
    setPhaseState('done');
    window.dispatchEvent(new CustomEvent(APP_EVENTS.onboardingChanged));
  }, []);

  if (phase === 'done') return null;

  // ── HOME PHASE: no dark scrim — overlay the live shell with the tour, then nudge ──
  if (phase === 'home') {
    return (
      <>
        {tourActive && (
          <TourOverlay
            steps={TOUR_STEPS}
            stepIndex={tourIdx}
            onStepChange={setTourIdx}
            onClose={() => endTour()}
            labels={{
              prev: t('onboarding.tour.prev'),
              skip: t('onboarding.tour.skip'),
              next: t('onboarding.tour.next'),
              done: t('onboarding.tour.done'),
            }}
          />
        )}
      </>
    );
  }

  // ── WELCOME / PROJECT PHASES: dark modal over the shell ──
  const stepStrip = (
    <div className="fx-ob-strip">
      {PHASE_ORDER.map((s, i) => {
        const cur = PHASE_ORDER.indexOf(phase);
        const active = s === phase;
        const passed = cur > i;
        return (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className={`fx-ob-dot${active ? ' active' : passed ? ' passed' : ''}`} />
            <span className={`fx-ob-lbl${active ? ' active' : ''}`}>{t(`onboarding.step.${s}`)}</span>
            {i < PHASE_ORDER.length - 1 && <span className="fx-ob-bar" />}
          </span>
        );
      })}
    </div>
  );

  return (
    <div className="fx-ob-overlay" role="dialog" aria-modal="true" aria-label={t('onboarding.welcome.title')}>
      <div className="fx-ob-card-shell">
        {stepStrip}
        <div className="fx-ob-frame">
          <div className="fx-ob-frame-body">
            {phase === 'welcome' ? (
              <WelcomeView
                t={t}
                lang={lang}
                onLang={onLang}
                selected={selected}
                setSelected={(v) => { setSelected(v); resetCheck(); }}
                baseUrl={baseUrl}
                setBaseUrl={(v) => { setBaseUrl(v); if (checkResult) resetCheck(); }}
                apiKey={apiKey}
                setApiKey={(v) => { setApiKey(v); if (checkResult) resetCheck(); }}
                cli={cli}
                setCli={(v) => { setCli(v); resetCheck(); }}
                cliProviders={cliProviders}
                checking={checking}
                checkResult={checkResult}
                checkFailMsg={checkFailMsg}
                connectedList={connectedList()}
              />
            ) : (
              <ProjectView
                t={t}
                projRoot={projRoot}
                onChangeRoot={() => void pickProjRoot()}
                projName={projName}
                setProjName={(v) => { setProjName(v); if (projErr) setProjErr(null); }}
                busy={projBusy}
                busyKind={projBusyKind}
                err={projErr}
                onNew={() => void startAction({ kind: 'new', root: projRoot, name: projName })}
                onTemplate={() => { setTmplSlug(null); setTmplOpen(true); }}
                onOpen={() => void pickOpenDir()}
                existingGames={existingGames}
                onOpenExisting={(slug) => void openExisting(slug)}
              />
            )}
          </div>
        </div>

        <div className="fx-ob-row" style={{ marginTop: 10 }}>
          <div className="fx-ob-grow" />
          {phase === 'welcome' && (
            <>
              {/* "skip" only skips model-connect → still lands on `project`; it
                  never jumps to home. Layout requires an initialized project. */}
              <button className="fx-ob-btn fx-ob-btn-ghost" onClick={skipConnect}>{t('onboarding.skip')}</button>
              <button
                className="fx-ob-btn fx-ob-btn-primary"
                disabled={checking}
                onClick={() => {
                  if (checking) return;
                  if (countdown !== null) { resetCheck(); setPhase('project'); return; }
                  void runCheck();
                }}
              >
                {checking ? t('onboarding.check.checking') : countdown !== null ? t('onboarding.nextCountdown', { n: countdown }) : t('onboarding.next')}
              </button>
            </>
          )}
          {/* project phase: no skip / no "next" — the only exit to home is a
              create/open action in ProjectView (each calls enterHomeWith). */}
        </div>
      </div>

      {phase === 'project' && tmplOpen && (
        <TemplateModal
          t={t}
          templates={templates}
          selected={tmplSlug}
          onSelect={setTmplSlug}
          onCancel={() => setTmplOpen(false)}
          onConfirm={() => { if (tmplSlug) { setTmplOpen(false); void startAction({ kind: 'template', root: projRoot, name: projName, template: tmplSlug }); } }}
          busy={projBusy}
        />
      )}
    </div>
  );
}

// ── sub-views ─────────────────────────────────────────────────────────────

export type TFn = ReturnType<typeof useTranslation>['t'];

function ConnectCard({
  selected, onSelect, title, sub, children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`fx-ob-card fx-ob-connect-card${selected ? ' sel' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      // Prevent focusing the card on mouse click: focus inside the overflow:auto
      // shell triggers scroll-into-view and looks like the text "shrinks"/jitters.
      // Keyboard users still get focus via Tab + Enter/Space.
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('input, textarea, button, [role="combobox"]')) return;
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="fx-ob-card-cb">
        <div className="fx-ob-stack fx-ob-gap6">
          <span className="fx-ob-connect-title">{title}</span>
          <div className="fx-ob-small fx-ob-sec">{sub}</div>
          {children}
        </div>
      </div>
    </div>
  );
}

function WelcomeView(props: {
  t: TFn; lang: Locale; onLang: (l: Locale) => void;
  selected: ConnectSelected; setSelected: (v: ConnectSelected) => void;
  baseUrl: string; setBaseUrl: (v: string) => void;
  apiKey: string; setApiKey: (v: string) => void;
  cli: CliId; setCli: (v: CliId) => void;
  cliProviders: CliProviderInfo[] | null;
  checking: boolean; checkResult: CheckResult; checkFailMsg: React.ReactNode; connectedList: string[];
}) {
  const { t } = props;
  return (
    <div className="fx-ob-stack fx-ob-gap14">
      <div className="fx-ob-stack fx-ob-gap6">
        <h2 className="fx-ob-h2">{t('onboarding.welcome.title')}</h2>
        <div className="fx-ob-sec">{t('onboarding.welcome.lead')}</div>
      </div>

      <div className="fx-ob-row">
        <span className="fx-ob-small fx-ob-muted">{t('onboarding.welcome.language')}</span>
        <span className={`fx-ob-pill${props.lang === 'zh' ? ' active' : ''}`} onClick={() => props.onLang('zh')}>中文</span>
        <span className={`fx-ob-pill${props.lang === 'en' ? ' active' : ''}`} onClick={() => props.onLang('en')}>English</span>
      </div>

      <div className="fx-ob-divider" />

      <div className="fx-ob-stack fx-ob-gap8">
        <div className="fx-ob-stack fx-ob-gap6">
          <h3 className="fx-ob-h3">{t('onboarding.connect.title')}</h3>
          <div className="fx-ob-tiny fx-ob-muted">{t('onboarding.connect.hint')}</div>
        </div>

        <div className="fx-ob-stack fx-ob-gap8">
          <ConnectCard
            selected={props.selected === 'key'}
            onSelect={() => props.setSelected('key')}
            title={t('onboarding.connect.keyTitle')}
            sub={t('onboarding.connect.keySub')}
          >
            <div className="fx-ob-stack fx-ob-gap6" style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
              <input
                className="fx-ob-input"
                placeholder="Base URL, e.g. https://api.openai.com/v1"
                value={props.baseUrl}
                onChange={(e) => {
                  if (props.selected !== 'key') props.setSelected('key');
                  props.setBaseUrl(e.target.value);
                }}
                onFocus={() => { if (props.selected !== 'key') props.setSelected('key'); }}
              />
              <input
                className="fx-ob-input"
                type="password"
                placeholder="API Key"
                value={props.apiKey}
                onChange={(e) => {
                  if (props.selected !== 'key') props.setSelected('key');
                  props.setApiKey(e.target.value);
                }}
                onFocus={() => { if (props.selected !== 'key') props.setSelected('key'); }}
              />
            </div>
          </ConnectCard>

          <ConnectCard
            selected={props.selected === 'cli'}
            onSelect={() => props.setSelected('cli')}
            title={t('onboarding.connect.cliTitle')}
            sub={t('onboarding.connect.cliSub')}
          >
            <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
              <Select
                value={props.cli}
                onValueChange={(v) => {
                  if (props.selected !== 'cli') props.setSelected('cli');
                  props.setCli(v as CliId);
                }}
                onOpenChange={(open) => {
                  if (open && props.selected !== 'cli') props.setSelected('cli');
                }}
              >
                <SelectTrigger className="rounded-[6px] border-[color:var(--ob-stroke-1)] text-[color:var(--ob-text)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[var(--z-toplevel)]">
                  {cliIdsFrom(props.cliProviders).map((id) => (
                    <SelectItem key={id} value={id}>
                      <CliOptionLabel t={t} id={id} providers={props.cliProviders} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </ConnectCard>
        </div>
      </div>

      {props.checking && <div className="fx-ob-callout info">{t('onboarding.check.checking')}</div>}
      {!props.checking && props.checkResult === 'ok' && (
        <div className="fx-ob-callout ok">{t('onboarding.check.ok', { list: props.connectedList.join(' / ') })}</div>
      )}
      {!props.checking && props.checkResult === 'fail' && (
        <div className="fx-ob-callout err">{props.checkFailMsg}</div>
      )}
    </div>
  );
}

function ProjectView(props: {
  t: TFn;
  projRoot: string; onChangeRoot: () => void;
  projName: string; setProjName: (v: string) => void;
  busy: boolean; busyKind: PendingIntent['kind'] | null; err: string | null;
  onNew: () => void; onTemplate: () => void; onOpen: () => void;
  existingGames: ExistingGame[] | null; onOpenExisting: (slug: string) => void;
}) {
  const { t } = props;
  const resolved = resolveProjectName(
    props.projName,
    (props.existingGames ?? []).map((g) => g.slug),
  );
  const busyMsg = props.busyKind ? t(`onboarding.project.busy.${props.busyKind}`) : t('onboarding.project.busy.new');
  // "New"/"template" create a game <slug> under the workspace root; "open" adopts
  // an existing game dir at any path (name not needed — derived server-side).
  // Empty name auto-resolves to untitled-N — never block create on the name field.
  const cards: { id: 'new' | 'sample' | 'open'; title: string; desc: string; cta: string; onGo: () => void }[] = [
    { id: 'new', title: t('onboarding.project.newTitle'), desc: t('onboarding.project.newDesc'), cta: t('onboarding.project.newCta'), onGo: props.onNew },
    { id: 'sample', title: t('onboarding.project.sampleTitle'), desc: t('onboarding.project.sampleDesc'), cta: t('onboarding.project.sampleCta'), onGo: props.onTemplate },
    { id: 'open', title: t('onboarding.project.openTitle'), desc: t('onboarding.project.openDesc'), cta: t('onboarding.project.openCta'), onGo: props.onOpen },
  ];
  return (
    <div className="fx-ob-stack fx-ob-gap12">
      <h2 className="fx-ob-h2">{t('onboarding.project.title')}</h2>
      {props.busy && (
        <div className="fx-ob-callout info fx-ob-busy" role="status" aria-live="polite">
          <span className="fx-ob-spinner" aria-hidden="true" />
          <span>{busyMsg}</span>
        </div>
      )}
      {/* Workspace already has games (returning user / pulled repo) → offer
          direct entry FIRST: pick one and go, creation below stays optional. */}
      {props.existingGames && props.existingGames.length > 0 && (
        <div className="fx-ob-panel">
          <div className="fx-ob-row"><span className="fx-ob-small fx-ob-sec" style={{ fontWeight: 500 }}>{t('onboarding.project.existingTitle')}</span></div>
          <div className="fx-ob-tiny" style={{ color: 'var(--ob-text-4)', marginTop: 4 }}>
            {t('onboarding.project.existingDesc', { count: String(props.existingGames.length) })}
          </div>
          <div className="fx-ob-stack fx-ob-gap8" style={{ marginTop: 8, maxHeight: 180, overflowY: 'auto' }}>
            {props.existingGames.map((g) => (
              <div
                key={g.slug}
                className="fx-ob-card"
                // flexShrink 0: .fx-ob-card has overflow:hidden → flex min-size 0,
                // so the maxHeight'd column would crush rows to ~0 instead of scrolling.
                style={{ cursor: props.busy ? 'default' : 'pointer', flexShrink: 0 }}
                onClick={() => { if (!props.busy) props.onOpenExisting(g.slug); }}
              >
                <div className="fx-ob-card-cb">
                  <div className="fx-ob-row">
                    <span className="fx-ob-small">{g.name}</span>
                    <span className="fx-ob-tiny fx-ob-muted" style={{ marginLeft: 8 }}>{g.slug}</span>
                    <div className="fx-ob-grow" />
                    <span className="fx-ob-pill sm static">{t('onboarding.project.existingOpen')}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="fx-ob-panel">
        <div className="fx-ob-row"><span className="fx-ob-small fx-ob-sec" style={{ fontWeight: 500 }}>{t('onboarding.project.root')}</span></div>
        <div className="fx-ob-row" style={{ marginTop: 6, gap: 8 }}>
          <input className="fx-ob-input" style={{ flex: 1, minWidth: 0 }} value={props.projRoot} readOnly />
          <button className="fx-ob-btn fx-ob-btn-secondary" style={{ whiteSpace: 'nowrap' }} disabled={props.busy} onClick={props.onChangeRoot}>{t('onboarding.project.changeRoot')}</button>
        </div>
        <div className="fx-ob-row" style={{ marginTop: 8 }}><span className="fx-ob-small fx-ob-sec" style={{ fontWeight: 500 }}>{t('onboarding.project.name')}</span></div>
        <div className="fx-ob-row" style={{ marginTop: 6 }}>
          <input className="fx-ob-input" style={{ flex: 1, minWidth: 0 }} placeholder={t('onboarding.project.namePlaceholder')} value={props.projName} onChange={(e) => props.setProjName(e.target.value)} />
        </div>
        <div className="fx-ob-tiny" style={{ color: 'var(--ob-text-4)', marginTop: 6 }}>
          {t('onboarding.project.willCreate', { name: resolved.slug })}
        </div>
      </div>
      <div className="fx-ob-grid3">
        {cards.map((o) => (
          <div key={o.id} className="fx-ob-card">
            <div className="fx-ob-card-ch"><span>{o.title}</span></div>
            <div className="fx-ob-card-cb">
              <div className="fx-ob-stack fx-ob-gap8">
                <div className="fx-ob-small fx-ob-sec">{o.desc}</div>
                <button
                  className="fx-ob-btn fx-ob-btn-secondary fx-ob-btn-block"
                  disabled={props.busy}
                  onClick={o.onGo}
                >{o.cta}</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {props.err && <div className="fx-ob-callout err">{props.err}</div>}
      <div className="fx-ob-tiny fx-ob-muted">{t('onboarding.project.footer')}</div>
    </div>
  );
}

function TemplateModal(props: {
  t: TFn; templates: TemplateInfo[] | null; selected: string | null;
  onSelect: (slug: string) => void; onCancel: () => void; onConfirm: () => void; busy: boolean;
}) {
  const { t } = props;
  const loading = props.templates === null;
  const empty = !loading && props.templates!.length === 0;
  return (
    <div className="fx-ob-modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <div className="fx-ob-modal">
        <div className="fx-ob-modal-inner">
          <h3 className="fx-ob-h3">{t('onboarding.template.title')}</h3>
          {loading && <div className="fx-ob-small fx-ob-muted">{t('onboarding.template.loading')}</div>}
          {empty && <div className="fx-ob-small fx-ob-muted">{t('onboarding.template.empty')}</div>}
          {!loading && !empty && (
            <div className="fx-ob-stack fx-ob-gap8" style={{ maxHeight: 320, overflowY: 'auto' }}>
              {props.templates!.map((tpl) => (
                <div key={tpl.slug} className={`fx-ob-card${props.selected === tpl.slug ? ' sel' : ''}`} style={{ cursor: 'pointer' }} onClick={() => props.onSelect(tpl.slug)}>
                  <div className="fx-ob-card-cb">
                    <div className="fx-ob-row">
                      <span className="fx-ob-small">{tpl.name}</span>
                      <span className="fx-ob-tiny fx-ob-muted" style={{ marginLeft: 8 }}>{tpl.slug}</span>
                      <div className="fx-ob-grow" />
                      {props.selected === tpl.slug && <span className="fx-ob-pill sm active static">{t('onboarding.template.picked')}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="fx-ob-row" style={{ justifyContent: 'flex-end' }}>
            <button className="fx-ob-btn fx-ob-btn-ghost" onClick={props.onCancel}>{t('onboarding.template.cancel')}</button>
            <button className="fx-ob-btn fx-ob-btn-primary" disabled={props.selected === null || props.busy} onClick={props.onConfirm}>{t('onboarding.template.confirm')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
