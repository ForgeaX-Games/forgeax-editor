/**
 * Trust panel — the UI half of the .fxpack import flow (Phase D6 path 3/4).
 *
 * The user pastes an absolute path to a .fxpack file (the daemon is local-host
 * only, so path-input is acceptable for v1; a dropzone with multipart upload is
 * deferred). On "Inspect", we POST /api/packs/inspect and render the returned
 * `FxpackTrustDescriptor`:
 *
 *   - signed?    — unsigned packs require an explicit `我了解` checkbox before
 *                  the install button enables (per ADR-0014 default-deny).
 *   - permissions[] per plugin — the receiver MUST see what the pack will do.
 *   - conflicts[]              — id already exists at L1/L2; user picks a
 *                                conflictPolicy (skip default).
 *   - warnings[]               — soft warnings ("未签名 · 请确认来源", etc.).
 *
 * Install POSTs /api/packs/install. The server triggers reload on success,
 * so the new plugin appears in the BusAdminPanel immediately.
 */
import { useState } from 'react';
import { Section } from '../TopBar/SettingsDrawer';
import { Download, ShieldAlert, ShieldCheck, AlertTriangle, FileWarning } from 'lucide-react';

interface TrustDescriptor {
  signed: boolean;
  publicKey?: string;
  permissions: Record<string, string[]>;
  conflicts: Array<{
    id: string;
    existingLayer: 'L0' | 'L1' | 'L2';
    existingVersion: string;
    newVersion: string;
  }>;
  warnings: string[];
}

interface InspectOk {
  ok: true;
  manifest: {
    id: string;
    version: string;
    title: { zh?: string; en?: string };
    description?: { zh?: string; en?: string };
    contains: Array<{ id: string; kind: string; version: string }>;
    author?: { name: string };
  };
  trust: TrustDescriptor;
}

interface InspectFail { ok: false; code: string; error: string; details?: unknown }

type InspectResult = InspectOk | InspectFail;

interface InstallOk { ok: true; installed: string[]; skipped: string[]; renamed: Record<string, string> }
interface InstallFail { ok: false; code: string; error: string; details?: unknown }
type InstallResult = InstallOk | InstallFail;

type ConflictPolicy = 'skip' | 'overwrite' | 'rename';

export function TrustPanel(): React.ReactNode {
  const [path, setPath] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspect, setInspect] = useState<InspectResult | null>(null);

  const [destRoot, setDestRoot] = useState('');
  const [destLayer, setDestLayer] = useState<'L1' | 'L2'>('L2');
  const [policy, setPolicy] = useState<ConflictPolicy>('skip');
  const [unsignedAck, setUnsignedAck] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [install, setInstall] = useState<InstallResult | null>(null);

  const doInspect = async (): Promise<void> => {
    if (!path.trim()) return;
    setInspecting(true);
    setInspect(null);
    setInstall(null);
    setUnsignedAck(false);
    try {
      const r = await fetch('/api/packs/inspect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.trim() }),
      });
      const j = (await r.json()) as InspectResult;
      setInspect(j);
    } catch (e) {
      setInspect({ ok: false, code: 'fetch_error', error: (e as Error).message });
    } finally {
      setInspecting(false);
    }
  };

  const doInstall = async (): Promise<void> => {
    if (!inspect?.ok || !destRoot.trim()) return;
    setInstalling(true);
    setInstall(null);
    try {
      const r = await fetch('/api/packs/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: path.trim(),
          destRoot: destRoot.trim(),
          destLayer,
          conflictPolicy: policy,
          reload: true,
        }),
      });
      const j = (await r.json()) as InstallResult;
      setInstall(j);
    } catch (e) {
      setInstall({ ok: false, code: 'fetch_error', error: (e as Error).message });
    } finally {
      setInstalling(false);
    }
  };

  const installEnabled =
    inspect?.ok === true &&
    !installing &&
    !!destRoot.trim() &&
    (inspect.trust.signed || unsignedAck);

  return (
    <>
      <Section icon={<Download size={14} />} title="导入 .fxpack" hint="本机绝对路径 — 浏览器侧暂不上传二进制">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="/abs/path/to/foo.fxpack"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            disabled={inspecting}
            style={inputStyle}
          />
          <button
            type="button"
            className="settings-edit-btn"
            onClick={() => void doInspect()}
            disabled={inspecting || !path.trim()}
          >
            {inspecting ? '检查中…' : '检查'}
          </button>
        </div>
        <div className="settings-help" style={{ marginTop: 6 }}>
          ADR-0014 默认拒绝 · 未签名包在确认前不能 install。Inspect 不写盘,只读 manifest 和权限。
        </div>
      </Section>

      {inspect && !inspect.ok && (
        <Section icon={<AlertTriangle size={14} />} title="检查失败" hint={inspect.code}>
          <div className="err-pill" style={{ display: 'inline-block', maxWidth: '100%', whiteSpace: 'normal' }}>
            {inspect.error}
          </div>
        </Section>
      )}

      {inspect?.ok && (
        <>
          <Section
            icon={inspect.trust.signed ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
            title="信任面板"
            hint={inspect.trust.signed ? '已签名' : '未签名 · 请确认来源'}
          >
            <div className="settings-info">
              <div><span className="dim">id:</span> <code>{inspect.manifest.id}</code> · v{inspect.manifest.version}</div>
              <div><span className="dim">title:</span> {pickTitle(inspect.manifest.title)}</div>
              {inspect.manifest.author && (
                <div><span className="dim">author:</span> {inspect.manifest.author.name}</div>
              )}
              <div><span className="dim">contains:</span> {inspect.manifest.contains.length} plugin(s)</div>
              <ul style={{ margin: '4px 0 0 18px' }}>
                {inspect.manifest.contains.map((c) => (
                  <li key={c.id} style={{ fontSize: 12 }}>
                    <code>{c.id}</code> · {c.kind} · v{c.version}
                  </li>
                ))}
              </ul>
              {inspect.trust.publicKey && (
                <div style={{ marginTop: 6 }}>
                  <span className="dim">public key:</span>{' '}
                  <code style={{ fontSize: 11 }}>{shortKey(inspect.trust.publicKey)}</code>
                </div>
              )}
            </div>
          </Section>

          <Section icon={<ShieldAlert size={14} />} title="权限声明" hint="manifest.permissions[] · 安装后由 host 信任,运行时强制将在后续版本接入">
            {Object.keys(inspect.trust.permissions).length === 0 ? (
              <div className="settings-help">无权限声明 — 这个包不会主动访问 fs / net。</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.entries(inspect.trust.permissions).map(([id, perms]) => (
                  <div key={id}>
                    <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                      <code>{id}</code>
                    </div>
                    {perms.length === 0 ? (
                      <div className="dim" style={{ fontSize: 11 }}>(无)</div>
                    ) : (
                      <ul style={{ margin: '2px 0 0 18px' }}>
                        {perms.map((p) => (
                          <li key={p} style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{p}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {inspect.trust.conflicts.length > 0 && (
            <Section icon={<FileWarning size={14} />} title="冲突" hint="本机已存在同 id">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {inspect.trust.conflicts.map((c) => (
                  <div key={c.id} className="settings-info">
                    <code>{c.id}</code> · 已在 {c.existingLayer} v{c.existingVersion} → 新包 v{c.newVersion}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {(['skip', 'overwrite', 'rename'] as const).map((p) => (
                  <label key={p} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <input type="radio" name="conflict-policy" checked={policy === p} onChange={() => setPolicy(p)} />
                    {policyLabel(p)}
                  </label>
                ))}
              </div>
            </Section>
          )}

          {inspect.trust.warnings.length > 0 && (
            <Section icon={<AlertTriangle size={14} />} title="警告" hint={`${inspect.trust.warnings.length} 条`}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {inspect.trust.warnings.map((w, i) => (
                  <li key={i} style={{ fontSize: 12, color: 'var(--text-primary)' }}>{w}</li>
                ))}
              </ul>
            </Section>
          )}

          <Section icon={<Download size={14} />} title="安装" hint="复制到 destRoot/.forgeax/plugins/<id>/ · 自动 reload">
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 8, alignItems: 'center' }}>
              <label className="settings-label">destRoot</label>
              <input
                type="text"
                placeholder={destLayer === 'L1' ? '通常: ~ (写入 ~/.forgeax/plugins/)' : '当前 project root'}
                value={destRoot}
                onChange={(e) => setDestRoot(e.target.value)}
                disabled={installing}
                style={inputStyle}
              />
              <label className="settings-label">layer</label>
              <div style={{ display: 'flex', gap: 12 }}>
                {(['L1', 'L2'] as const).map((l) => (
                  <label key={l} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <input type="radio" name="dest-layer" checked={destLayer === l} onChange={() => setDestLayer(l)} />
                    {l === 'L1' ? 'L1 · 用户级' : 'L2 · 项目级'}
                  </label>
                ))}
              </div>
            </div>
            {!inspect.trust.signed && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12 }}>
                <input type="checkbox" checked={unsignedAck} onChange={(e) => setUnsignedAck(e.target.checked)} />
                <span>我了解此包未签名,来源由我自己负责</span>
              </label>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="button"
                className="settings-edit-btn"
                onClick={() => void doInstall()}
                disabled={!installEnabled}
              >
                {installing ? '安装中…' : '安装'}
              </button>
            </div>
          </Section>

          {install && (
            <Section
              icon={install.ok ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
              title="安装结果"
              hint={install.ok ? 'reload 已触发' : install.code}
            >
              {install.ok ? (
                <div className="settings-info">
                  <div><span className="dim">installed:</span> {install.installed.join(', ') || '(无)'}</div>
                  {install.skipped.length > 0 && (
                    <div><span className="dim">skipped (conflict):</span> {install.skipped.join(', ')}</div>
                  )}
                  {Object.keys(install.renamed).length > 0 && (
                    <div>
                      <span className="dim">renamed:</span>{' '}
                      {Object.entries(install.renamed).map(([from, to]) => `${from} → ${to}`).join(', ')}
                    </div>
                  )}
                </div>
              ) : (
                <div className="err-pill" style={{ display: 'inline-block', maxWidth: '100%', whiteSpace: 'normal' }}>
                  {install.error}
                </div>
              )}
            </Section>
          )}
        </>
      )}
    </>
  );
}

function policyLabel(p: ConflictPolicy): string {
  if (p === 'skip') return 'skip · 保留旧版(默认)';
  if (p === 'overwrite') return 'overwrite · 覆盖旧版';
  return 'rename · 新版改名 <id>-<ts>';
}

function pickTitle(t: { zh?: string; en?: string }): string {
  return t.zh ?? t.en ?? '(无标题)';
}

function shortKey(k: string): string {
  if (k.length <= 24) return k;
  return `${k.slice(0, 12)}…${k.slice(-8)}`;
}

const inputStyle = {
  flex: 1,
  background: 'rgba(0,0,0,0.4)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 5,
  padding: '6px 9px',
  color: 'var(--text-primary)',
  fontSize: 12,
  fontFamily: 'inherit',
  outline: 'none',
} as const;
