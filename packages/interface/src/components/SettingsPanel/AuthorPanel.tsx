/**
 * Author panel — Fork + Record-as-skill entry (Phase D6 path 2/4).
 *
 * Backed by:
 *   POST /api/plugins/fork          — copy + manifest patch + reload
 *   POST /api/plugins/record-skill  — backend live; the chat-driven path is
 *                                     `meta:author-plugin` (skill-author-plugin
 *                                     plugin); this panel currently exposes
 *                                     only the chat-flow handoff because the
 *                                     real call requires a `recorded[]` event
 *                                     selection UI not yet in this panel.
 */
import { useEffect, useState } from 'react';
import { Section } from '../TopBar/SettingsDrawer';
import { GitFork, Mic, RefreshCw } from 'lucide-react';
import { useTranslation } from '@/i18n';

interface ManifestRow {
  id: string;
  version: string;
  kind: string;
  layer: 'L0' | 'L1' | 'L2';
  displayName?: string | { en?: string; zh?: string };
}

interface ManifestsResp { manifests: ManifestRow[] }

type ForkResult =
  | { ok: true; id: string; dir: string; layer: 'L1' | 'L2' }
  | { ok: false; code: string; error: string };

export function AuthorPanel(): React.ReactNode {
  const { t } = useTranslation();
  const [manifests, setManifests] = useState<ManifestRow[] | null>(null);
  const [srcId, setSrcId] = useState('');
  const [newId, setNewId] = useState('');
  const [destLayer, setDestLayer] = useState<'L1' | 'L2'>('L1');
  const [projectRoot, setProjectRoot] = useState('');
  const [forking, setForking] = useState(false);
  const [forkResult, setForkResult] = useState<ForkResult | null>(null);


  const loadManifests = async (): Promise<void> => {
    try {
      const r = await fetch('/api/plugins/manifests');
      const j = (await r.json()) as ManifestsResp;
      setManifests(j.manifests ?? []);
    } catch {
      setManifests([]);
    }
  };

  useEffect(() => { void loadManifests(); }, []);

  // Auto-fill newId when srcId changes (UX nicety; user can still edit).
  useEffect(() => {
    if (!srcId) { setNewId(''); return; }
    const suggested = srcId.endsWith('-mine') ? `${srcId}-2` : `${srcId}-mine`;
    setNewId(suggested);
  }, [srcId]);

  const doFork = async (): Promise<void> => {
    if (!srcId) return;
    setForking(true);
    setForkResult(null);
    try {
      const r = await fetch('/api/plugins/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          srcId,
          newId: newId || undefined,
          destLayer,
          projectRoot: destLayer === 'L2' ? (projectRoot || undefined) : undefined,
        }),
      });
      const j = (await r.json()) as ForkResult;
      setForkResult(j);
      if (j.ok) await loadManifests();
    } catch (e) {
      setForkResult({ ok: false, code: 'fetch_error', error: (e as Error).message });
    } finally {
      setForking(false);
    }
  };

  const forkable = (manifests ?? []).filter((m) => !m.id.startsWith('@forgeax-internal/'));

  return (
    <>
      <Section icon={<GitFork size={14} />} title={t('author.fork.title')} hint={t('author.fork.hint')}>
        <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 8, alignItems: 'center' }}>
          <label className="settings-label">{t('author.fork.sourceLabel')}</label>
          <select
            value={srcId}
            onChange={(e) => setSrcId(e.target.value)}
            disabled={forking || manifests === null}
            style={selectStyle}
          >
            <option value="">{t('author.fork.selectPlaceholder')}</option>
            {forkable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} (v{m.version} · {m.layer} · {m.kind})
              </option>
            ))}
          </select>

          <label className="settings-label">{t('author.fork.newIdLabel')}</label>
          <input
            type="text"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="@me/foo-mine"
            disabled={forking || !srcId}
            style={inputStyle}
          />

          <label className="settings-label">{t('author.fork.destLayerLabel')}</label>
          <div style={{ display: 'flex', gap: 12 }}>
            {(['L1', 'L2'] as const).map((l) => (
              <label key={l} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="radio" name="fork-layer" checked={destLayer === l} onChange={() => setDestLayer(l)} />
                {l === 'L1' ? t('author.fork.layerL1') : t('author.fork.layerL2')}
              </label>
            ))}
          </div>

          {destLayer === 'L2' && (
            <>
              <label className="settings-label">project root</label>
              <input
                type="text"
                value={projectRoot}
                onChange={(e) => setProjectRoot(e.target.value)}
                placeholder="/abs/path/to/project"
                disabled={forking}
                style={inputStyle}
              />
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <button
            type="button"
            className="settings-edit-btn"
            onClick={() => void doFork()}
            disabled={forking || !srcId || (destLayer === 'L2' && !projectRoot)}
          >
            {forking ? t('author.fork.copying') : 'Fork'}
          </button>
          <button
            type="button"
            className="settings-edit-btn"
            onClick={() => void loadManifests()}
            disabled={forking}
            title={t('author.fork.refreshTitle')}
          >
            <RefreshCw size={11} /> {t('author.fork.refresh')}
          </button>
        </div>

        {forkResult && (
          <div style={{ marginTop: 10 }}>
            {forkResult.ok ? (
              <div className="settings-info">
                <span className="ok-pill">{t('author.fork.doneBadge')}</span>
                <div style={{ marginTop: 4 }}><code>{forkResult.id}</code> → <code>{forkResult.dir}</code></div>
                <div className="settings-help">{t('author.fork.doneHelp')}</div>
              </div>
            ) : (
              <div className="err-pill" style={{ display: 'inline-block', maxWidth: '100%', whiteSpace: 'normal' }}>
                {forkResult.code}: {forkResult.error}
              </div>
            )}
          </div>
        )}

        <div className="settings-help" style={{ marginTop: 10 }}>
          {t('author.fork.note')}
        </div>
      </Section>

      <Section icon={<Mic size={14} />} title={t('author.record.title')} hint={t('author.record.hint')}>
        <div className="settings-help" style={{ marginTop: 4 }}>
          {t('author.record.backendPre')} <code>POST /api/plugins/record-skill</code> {t('author.record.backendMid')} (<code>recorded[]</code>) {t('author.record.backendMid2')}
          {' '}<code>meta:author-plugin</code>{' '}{t('author.record.backendMid3')}
          {' '}<code>/author-plugin</code>{' '}{t('author.record.backendPost')}
        </div>
        <div className="settings-help" style={{ marginTop: 6 }}>
          {t('author.record.draftPre')} <code>~/.forgeax/plugins/skill-&lt;name&gt;/SKILL.md</code>{t('author.record.draftMid')} <code>09-NON-EXPERT-AUTHORING §2.3</code>{t('author.record.draftPost')}
        </div>
      </Section>
    </>
  );
}

const inputStyle = {
  background: 'rgba(0,0,0,0.4)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 5,
  padding: '6px 9px',
  color: 'var(--text-primary)',
  fontSize: 12,
  fontFamily: 'inherit',
  outline: 'none',
} as const;

const selectStyle = inputStyle;
