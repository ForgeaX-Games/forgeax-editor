// Mesh panel — right-dock sibling of the Material panel.
//
// Data display mirrors UE5.8's Static Mesh Editor: a high-frequency "Overview"
// (Mesh Statistics) block + collapsible sections (Sections / Vertex Attributes),
// with UE-style field names (Triangles / Vertices / Approx Size / LODs / Index
// Format). Fields the current engine cannot supply (LOD>1, Nanite, Distance
// Field, Collision) are NOT faked — they are omitted or shown as "—" so the
// numbers never mislead. Design: docs/design/editor-mesh-panel-ue58-parity.md.
//
// Two modes (mirrors Material.tsx):
//   • Asset preview — a `mesh` sub-asset is selected in the Content Browser
//     (double-click). Geometry stats come from the MAIN window via the
//     `meshStats` broadcast (this iframe has no engine asset registry).
//   • Entity mode — an entity with a `Mesh` component is selected: shows the
//     primitive `kind` + bound `meshAsset` GUID (read-only in v1).
import { useCallback, useState } from 'react';
import { bus, useDocVersion, useSelection, useAssetSelection, useMeshStats } from '@forgeax/editor-shared';
import { useTranslation } from '@forgeax/editor-shared/i18n';

const short = (g: string): string => (g.length > 12 ? `${g.slice(0, 8)}…${g.slice(-3)}` : g);

// ForgeaX world space is METERS (gravity -9.81, KHR light range in meters, 1×1×1
// builtins). UE uses cm — so we show the native meters first and cm in parens for
// artists migrating from UE. Design §6.3. AABB is 6 floats: [min xyz, max xyz].
function aabbDims(a: readonly number[]): { m: string; cm: string } {
  const v = (i: number): number => (Number.isFinite(a[i] ?? NaN) ? (a[i] as number) : 0);
  const dx = v(3) - v(0);
  const dy = v(4) - v(1);
  const dz = v(5) - v(2);
  const m = (n: number): string => n.toFixed(2);
  const cm = (n: number): string => Math.round(n * 100).toLocaleString();
  return { m: `${m(dx)} × ${m(dy)} × ${m(dz)} m`, cm: `${cm(dx)} × ${cm(dy)} × ${cm(dz)} cm` };
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function StatRow({ k, v, title }: { k: string; v: string | number; title?: string }) {
  return (
    <div className="mat-row" title={title}>
      <span className="mat-k">{k}</span>
      <span className="mat-val" style={{ flex: 1, textAlign: 'left' }}>{v}</span>
    </div>
  );
}

const COLLAPSE_KEY = 'forgeax:mesh-panel:collapsed';

/** Collapsible section whose open/closed state persists in localStorage so the
 *  panel layout survives reloads / pop-outs (parity-doc §5.3, §7.1). */
function Section({ id, title, defaultOpen = true, children }: { id: string; title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(`${COLLAPSE_KEY}:${id}`);
      return v == null ? defaultOpen : v === '1';
    } catch {
      return defaultOpen;
    }
  });
  const toggle = useCallback(() => {
    setOpen((o) => {
      const next = !o;
      try { localStorage.setItem(`${COLLAPSE_KEY}:${id}`, next ? '1' : '0'); } catch { /* storage blocked */ }
      return next;
    });
  }, [id]);
  return (
    <div className="mesh-sec">
      <button type="button" className="mesh-sec-h" aria-expanded={open} onClick={toggle}>
        <span className="mesh-sec-caret">{open ? '▾' : '▸'}</span>
        <span className="mesh-sec-title">{title}</span>
      </button>
      {open ? <div className="mesh-sec-body">{children}</div> : null}
    </div>
  );
}

type Stats = NonNullable<ReturnType<typeof useMeshStats>>;

/** UE-parity stats view: Overview (Mesh Statistics) + Sections + Attributes. */
function MeshStatsView({ stats }: { stats: Stats }) {
  const { t } = useTranslation();
  // Only call it "Triangles" when every submesh is triangle-topology; otherwise
  // the count mixes lines/points and "Triangles" would be wrong (engine §7.3).
  const allTriangles = stats.submeshes.length === 0 || stats.submeshes.every((s) => s.topology.startsWith('triangle'));
  // UV-channel detection is best-effort: `attributes` reliably carries skin data
  // but UV presence may be absent on interleaved meshes — show "—" when unknown
  // rather than a wrong number (parity-doc §6.2). Precise count is v3.
  const uv = stats.attributes.includes('uv') ? 1 : 0;
  const dims = stats.aabb != null && stats.aabb.length === 6 ? aabbDims(stats.aabb) : null;
  return (
    <>
      <Section id="overview" title={t('editor.mesh.secOverview')}>
        <StatRow k={allTriangles ? t('editor.mesh.triangles') : t('editor.mesh.primitives')} v={stats.primitiveCount.toLocaleString()} />
        <StatRow k={t('editor.mesh.vertices')} v={stats.vertexCount.toLocaleString()} />
        <StatRow k={t('editor.mesh.uvChannels')} v={uv > 0 ? uv : '—'} title={t('editor.mesh.uvChannelsTitle')} />
        {dims != null ? (
          <div className="mat-row">
            <span className="mat-k">{t('editor.mesh.approxSize')}</span>
            <span className="mat-val" style={{ flex: 1, textAlign: 'left' }}>
              {dims.m}<span className="mesh-cm"> ({dims.cm})</span>
            </span>
          </div>
        ) : null}
        <StatRow k={t('editor.mesh.lods')} v={t('editor.mesh.noLod')} title={t('editor.mesh.lodsTitle')} />
        <StatRow k={t('editor.mesh.indexFormat')} v={stats.indexFormat === 'none' ? t('editor.mesh.nonIndexed') : stats.indexFormat.toUpperCase()} />
        {typeof stats.byteSize === 'number' && stats.byteSize > 0 ? (
          <StatRow k={t('editor.mesh.estSize')} v={formatBytes(stats.byteSize)} title={t('editor.mesh.estSizeTitle')} />
        ) : null}
      </Section>

      {stats.submeshes.length > 0 ? (
        <Section id="sections" title={`${t('editor.mesh.secSections')} (${stats.submeshes.length})`}>
          {stats.submeshes.map((s, i) => (
            <div className="mat-row" key={i}>
              <span className="mat-k">· {i}</span>
              <span className="mat-val" style={{ flex: 1, textAlign: 'left' }}>{s.topology} · {s.primitiveCount.toLocaleString()}</span>
            </div>
          ))}
        </Section>
      ) : null}

      <Section id="attributes" title={t('editor.mesh.secAttributes')} defaultOpen={false}>
        <div className="mat-row">
          <span className="mat-k">{t('editor.mesh.attributes')}</span>
          <span className="mat-val" style={{ flex: 1, textAlign: 'left' }}>{stats.attributes.length > 0 ? stats.attributes.join(', ') : '—'}</span>
        </div>
        <StatRow k={t('editor.mesh.skinned')} v={stats.attributes.includes('skinIndex') ? t('editor.mesh.yes') : t('editor.mesh.no')} />
      </Section>
    </>
  );
}

/** Import provenance from the mesh sub-asset's Content Browser payload
 *  (importer / source path). UE's Static Mesh Editor has an "Import" section;
 *  this is the read-only parity equivalent. Parity-doc §5.1, §8 (v2). */
function ImportSection({ payload }: { payload?: Record<string, unknown> }) {
  const { t } = useTranslation();
  const source = payload && typeof payload.source === 'string' ? payload.source : '';
  const importer = payload && typeof payload.importer === 'string' ? payload.importer : '';
  if (!source && !importer) return null;
  return (
    <Section id="import" title={t('editor.mesh.secImport')} defaultOpen={false}>
      {source ? <StatRow k={t('editor.mesh.importSource')} v={source} /> : null}
      {importer ? <StatRow k={t('editor.mesh.importImporter')} v={importer} /> : null}
    </Section>
  );
}

/** Read-only preview of a mesh sub-asset selected in the Content Browser.
 *  Stats arrive via the main-window `meshStats` broadcast keyed by GUID. */
function PackMeshPreview({ name, guid, payload }: { name: string; guid: string; payload?: Record<string, unknown> }) {
  const { t } = useTranslation();
  const raw = useMeshStats();
  // Narrow to non-null only when the broadcast matches THIS asset (a stale entry
  // can linger for a frame while the main window reloads on a selection change).
  const stats = raw != null && raw.guid === guid ? raw : null;

  return (
    <div className="panel ed-mesh" data-testid="panel-mesh">
      <h3>Mesh · {name}</h3>
      {stats == null ? (
        <div className="muted mat-hint">{t('editor.mesh.loading')}</div>
      ) : stats.error ? (
        <div className="muted mat-hint">{t('editor.mesh.loadError', { error: stats.error })}</div>
      ) : (
        <MeshStatsView stats={stats} />
      )}
      <ImportSection payload={payload} />
      <div className="mat-row">
        <span className="mat-k">GUID</span>
        <span className="mat-slot on" style={{ fontSize: '10px' }}>{guid}</span>
      </div>
      <div className="muted mat-hint">{t('editor.mesh.hint')}</div>
    </div>
  );
}

export function MeshPanel() {
  useDocVersion();
  const { t } = useTranslation();
  const sel = useSelection();
  const assetSel = useAssetSelection();
  // Called unconditionally (hooks rule); entity mode below matches it against the
  // selected entity's bound meshAsset guid. The MAIN window publishes stats for the
  // active mesh (entity-bound or asset-selected) — see edit-runtime main.tsx.
  const meshStatsRaw = useMeshStats();
  const node = sel !== null ? bus.doc.entities[sel] : undefined;
  const mesh = node?.components.Mesh as Record<string, unknown> | undefined;

  // No entity selected but a mesh asset is selected in the Content Browser.
  if ((sel === null || !node) && assetSel?.kind === 'mesh') {
    return <PackMeshPreview name={assetSel.name} guid={assetSel.guid} payload={assetSel.payload} />;
  }
  if (sel === null || !node) {
    return (
      <div className="panel ed-mesh" data-testid="panel-mesh">
        <h3>Mesh</h3>
        <div className="muted mat-empty">{t('editor.mesh.empty')}</div>
      </div>
    );
  }
  if (!mesh) {
    if (assetSel?.kind === 'mesh') return <PackMeshPreview name={assetSel.name} guid={assetSel.guid} payload={assetSel.payload} />;
    return (
      <div className="panel ed-mesh" data-testid="panel-mesh">
        <h3>Mesh</h3>
        <div className="muted mat-empty">{t('editor.mesh.noComponent', { name: node.name })}</div>
      </div>
    );
  }

  // Entity mode — show the primitive kind + bound mesh-asset GUID (read-only, v1).
  const kind = typeof mesh.kind === 'string' ? mesh.kind : '—';
  const guid = typeof mesh.meshAsset === 'string' ? (mesh.meshAsset as string) : '';
  // Material Slots (v2): the editor models a single `Material` component (not the
  // engine's per-section MeshRenderer.materials[]), so we reflect it as one slot.
  // Per-submesh material binding lives on the instance — noted, not faked.
  const material = node.components.Material as Record<string, unknown> | undefined;
  const matGuid = material && typeof material.materialAsset === 'string' ? (material.materialAsset as string) : '';
  // Geometry stats for the bound mesh asset (published by the main window keyed by
  // GUID). Inline primitives (no meshAsset GUID) have no loadable geometry, so we
  // show "—" rather than fake a count. A guid mismatch means the main window is
  // still loading → show the loading hint (parity-doc §5.1, §6).
  const entityStats = guid !== '' && meshStatsRaw != null && meshStatsRaw.guid === guid ? meshStatsRaw : null;
  return (
    <div className="panel ed-mesh" data-testid="panel-mesh">
      <h3>Mesh · {node.name}</h3>
      {/* `kind` (cube/sphere/cylinder) is the builtin-primitive fallback; when a
          meshAsset GUID is bound it WINS and the engine ignores `kind` (often a
          stale default 'cube' — see drag-asset-spawn.ts / scene-types MeshData).
          So only surface `kind` for a true inline primitive, else it misleads. */}
      {guid === '' ? <StatRow k={t('editor.mesh.kind')} v={kind} /> : null}
      <div className="mat-row">
        <span className="mat-k">{t('editor.mesh.meshAsset')}</span>
        <span className={`mat-slot${guid ? ' on' : ''}`} title={guid || t('editor.mesh.primitive')}>{guid ? short(guid) : t('editor.mesh.primitive')}</span>
      </div>
      {guid === '' ? (
        <StatRow k={t('editor.mesh.triangles')} v="—" title={t('editor.mesh.primitive')} />
      ) : entityStats == null ? (
        <div className="muted mat-hint">{t('editor.mesh.loading')}</div>
      ) : entityStats.error ? (
        <div className="muted mat-hint">{t('editor.mesh.loadError', { error: entityStats.error })}</div>
      ) : (
        <MeshStatsView stats={entityStats} />
      )}
      {material ? (
        <Section id="materials" title={t('editor.mesh.secMaterials')}>
          <div className="mat-row">
            <span className="mat-k">{t('editor.mesh.materialSlot', { i: 0 })}</span>
            <span className={`mat-slot${matGuid ? ' on' : ''}`} title={matGuid || t('editor.mesh.inlineMaterial')}>{matGuid ? short(matGuid) : t('editor.mesh.inlineMaterial')}</span>
          </div>
          <div className="muted mat-hint">{t('editor.mesh.materialsNote')}</div>
        </Section>
      ) : null}
      {guid === '' ? <div className="muted mat-hint">{t('editor.mesh.entityHint')}</div> : null}
    </div>
  );
}
