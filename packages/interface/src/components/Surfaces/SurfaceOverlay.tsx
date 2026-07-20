/**
 * Phase D2 — dev-mode surface overlay.
 *
 * A panel listing every `surface.expose` snapshot received from plugin
 * iframes (07-INTERFACE-EXPOSURE.md §1.2). Lets the user / author / AI
 * see "this UI element is equivalent to tool X with args Y" without
 * cracking open devtools.
 *
 * UX: entry point is a `surfaces · N` chip in the global status bar
 * (right slot). Clicking the chip toggles the panel; default closed so
 * the workspace isn't covered. Production builds omit the entire
 * subtree via the DEV gate on the wrapper.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { EyeOff, Play } from 'lucide-react';
import { listSurfaces, subscribeSurfaces, type SurfaceState, type SurfaceAction } from '../../lib/surface-store';
import { SchemaForm, type JsonSchema } from '../SchemaForm/SchemaForm';
import { useStatusBarItem } from '../StatusBar/store';
import { useTranslation } from '@/i18n';
import './SurfaceOverlay.css';

interface ToolDescriptorLite {
  id: string;
  argsSchema?: unknown;
  requireConfirm?: boolean;
}

async function fetchTools(): Promise<ToolDescriptorLite[]> {
  try {
    const r = await fetch('/api/tools');
    if (!r.ok) return [];
    const j = (await r.json()) as { tools?: ToolDescriptorLite[] };
    return j.tools ?? [];
  } catch {
    return [];
  }
}

export function SurfaceOverlay(): ReactElement | null {
  if (!import.meta.env.DEV) return null;
  return <SurfaceOverlayDev />;
}

function SurfaceOverlayDev(): ReactElement | null {
  const { t } = useTranslation();
  const [surfaces, setSurfaces] = useState<SurfaceState[]>(() => listSurfaces());
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<ToolDescriptorLite[]>([]);

  useEffect(() => {
    const off = subscribeSurfaces(() => setSurfaces(listSurfaces()));
    return off;
  }, []);

  // Doc 07 §4 — load tool catalog so the dev overlay can render a SchemaForm
  // for each surface action whose `id` matches a registered tool. Re-fetched
  // on plugin reload via SSE; cheap, ~1KB payload.
  useEffect(() => {
    let cancelled = false;
    const reload = () => fetchTools().then((next) => { if (!cancelled) setTools(next); });
    void reload();
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/events/stream?topic=plugin.reloaded');
      es.addEventListener('event', () => { void reload(); });
    } catch { /* fall back to single fetch */ }
    return () => { cancelled = true; if (es) es.close(); };
  }, []);

  const toolsById = useMemo(() => {
    const m = new Map<string, ToolDescriptorLite>();
    for (const tool of tools) m.set(tool.id, tool);
    return m;
  }, [tools]);

  // Status-bar entry — low priority so it joins the right-slot carousel
  // pool rather than anchoring; this is a dev-only debugging surface and
  // shouldn't crowd out the always-visible state chips.
  useStatusBarItem({
    id: 'surface-overlay',
    slot: 'right',
    priority: 10,
    node: (
      <button
        type="button"
        className={`sb-chip fx-surf-chip${open ? ' fx-surf-chip-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={open ? t('surfaces.chip.close') : t('surfaces.chip.open')}
      >
        surfaces · {surfaces.length}
      </button>
    ),
  });

  if (!open) return null;

  return (
    <div className="fx-surf-overlay" role="complementary" aria-label="surface overlay">
      <div className="fx-surf-overlay-head">
        <span className="fx-surf-overlay-title">surfaces · {surfaces.length}</span>
        <button
          type="button"
          className="fx-surf-overlay-hide"
          onClick={() => setOpen(false)}
          title={t('common.close')}
        >
          <EyeOff size={12} />
        </button>
      </div>
      <div className="fx-surf-overlay-body">
        {surfaces.length === 0 ? (
          <div className="fx-surf-overlay-empty">{t('surfaces.overlay.empty')}</div>
        ) : (
          surfaces.map((s) => (
            <SurfaceCard
              key={`${s.extensionId}:${s.surfaceId}`}
              surface={s}
              toolsById={toolsById}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SurfaceCard({
  surface,
  toolsById,
}: {
  surface: SurfaceState;
  toolsById: Map<string, ToolDescriptorLite>;
}): ReactElement {
  return (
    <div className="fx-surf-card">
      <div className="fx-surf-card-head">
        <span className="fx-surf-plugin">{surface.extensionId}</span>
        <span className="fx-surf-id">{surface.surfaceId}</span>
      </div>
      <ul className="fx-surf-actions">
        {surface.actions.map((a) => (
          <SurfaceActionRow
            key={a.id}
            action={a}
            tool={toolsById.get(a.id)}
            extensionId={surface.extensionId}
          />
        ))}
        {surface.actions.length === 0 ? <li className="fx-surf-empty">(no actions)</li> : null}
      </ul>
    </div>
  );
}

/** D2 — single surface-action row. Has a "▶" toggle that opens an inline
 *  SchemaForm seeded with the action's args snapshot + the tool's argsSchema
 *  (when registered). Submitting POSTs `/api/tools/call` as caller=user
 *  (workbench surface — the dev clicked the form). The legacy <pre>args view
 *  is preserved for actions with no schema or no matching tool registration. */
function SurfaceActionRow({
  action,
  tool,
  extensionId,
}: {
  action: SurfaceAction;
  tool?: ToolDescriptorLite;
  extensionId: string;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const argsSchema = (tool?.argsSchema ?? null) as JsonSchema | null;
  const canRun = !!argsSchema && action.enabled !== false;

  const submit = async (value: unknown) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/tools/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolId: action.id,
          args: value,
          caller: { kind: 'user', agentId: extensionId },
        }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string; result?: unknown };
      setResult(j.ok ? 'ok' : (j.error ?? 'failed'));
      if (j.ok) setOpen(false);
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`fx-surf-action${action.enabled ? '' : ' fx-surf-action-disabled'}`}>
      <code className="fx-surf-action-id">{action.id}</code>
      {action.label ? <span className="fx-surf-action-label">{action.label}</span> : null}
      {action.hotkey ? <kbd className="fx-surf-hotkey">{action.hotkey}</kbd> : null}
      {canRun ? (
        <button
          type="button"
          className="fx-surf-action-run"
          onClick={() => setOpen((v) => !v)}
          title={open ? t('surfaces.action.formClose') : t('surfaces.action.formOpen')}
        >
          <Play size={10} /> {open ? t('surfaces.action.collapse') : t('surfaces.action.run')}
        </button>
      ) : null}
      {!open && action.args ? <pre className="fx-surf-args">{summarizeArgs(action.args)}</pre> : null}
      {open && argsSchema ? (
        <div className="fx-surf-action-form">
          <SchemaForm
            schema={argsSchema}
            initialValue={action.args}
            onSubmit={(v) => void submit(v)}
            onCancel={() => setOpen(false)}
            submitLabel={tool?.requireConfirm ? t('surfaces.action.runConfirm') : t('surfaces.action.run')}
            layout="inline"
            busy={busy}
          />
          {result ? <div className="fx-surf-action-result">{result}</div> : null}
        </div>
      ) : null}
    </li>
  );
}

function summarizeArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  } catch {
    return String(args);
  }
}
