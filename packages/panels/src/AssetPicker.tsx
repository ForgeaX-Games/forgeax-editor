// AssetPicker — a Unity-style modal asset browser for Inspector asset fields.
//
// The Inspector asset widgets are drop-only: to bind a mesh/material you must
// drag a Content Browser row onto the field. This modal adds the second,
// discoverable path — click the field's "browse" affordance to open a searchable,
// type-filtered list of catalogued assets and pick one.
//
// Self-contained overlay (no portal / no AssetThumbnail dependency — this editor
// copy has none). Data comes from the gateway read surface the drop path uses:
//   - gateway.assetCatalog()          → { guid, kind, name, relativeUrl }[]
//   - gateway.describeAssetByGuid(g)  → { kind, meta } for a lightweight swatch
// Filtering is by assetKindToType(entry.kind) === the field's expected asset type
// (parsed from the engine schema's shared<T> keyword by the caller), so the picker
// can never offer an asset the field would reject.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { gateway } from '@forgeax/editor-core';

// kind → editor asset-union tag. Mirrors the (newer) core schema.ts
// assetKindToType; inlined here because this editor copy's schema.ts predates
// that export. Keep in sync if the engine adds asset kinds.
function assetKindToType(kind: string): string | null {
  switch (kind) {
    case 'mesh': return 'MeshAsset';
    case 'material': return 'MaterialAsset';
    case 'texture':
    case 'image': return 'TextureAsset';
    case 'cube-texture': return 'CubeTextureAsset';
    case 'equirect': return 'EquirectAsset';
    case 'video': return 'VideoAsset';
    case 'audio': return 'AudioAsset';
    case 'animation':
    case 'clip': return 'AnimationClip';
    case 'scene': return 'SceneAsset';
    case 'font': return 'FontAsset';
    default: return null;
  }
}

export interface AssetPickerProps {
  /** The field's expected asset-union type, e.g. 'MeshAsset' / 'MaterialAsset'. */
  assetType: string;
  /** GUID of the currently bound asset (to mark the active row), if any. */
  currentGuid?: string | null;
  /** Bind the chosen asset's GUID to the field. */
  onPick: (guid: string) => void;
  /** Unbind (clear) the field. Omit to hide the "None" row. */
  onClear?: () => void;
  /** Dismiss without changing the binding. */
  onClose: () => void;
}

interface Row {
  guid: string;
  kind: string;
  name: string;
}

// A tiny inline swatch: material → its baseColor square, everything else → a
// kind-lettered box. Avoids a full thumbnail renderer (absent in this copy).
function Swatch({ guid, kind }: { guid: string; kind: string }) {
  const desc = gateway.describeAssetByGuid(guid);
  const meta = desc?.ok ? (desc.meta as Record<string, unknown> | undefined) : undefined;
  const bc = (meta?.paramValues as Record<string, unknown> | undefined)?.baseColor as number[] | undefined;
  const color = kind === 'material' && bc && bc.length >= 3
    ? `rgb(${Math.round(bc[0]! * 255)},${Math.round(bc[1]! * 255)},${Math.round(bc[2]! * 255)})`
    : 'var(--bg2, #2c3138)';
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, minWidth: 20, borderRadius: 3,
        border: '1px solid var(--line, #3a3f46)', background: color,
        fontSize: 10, color: 'var(--fg3, #9aa0a6)', textTransform: 'uppercase',
      }}
    >
      {kind === 'material' ? '' : kind.slice(0, 1)}
    </span>
  );
}

export function AssetPicker({ assetType, currentGuid, onPick, onClear, onClose }: AssetPickerProps) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const rows = useMemo<Row[]>(() => {
    const catalog = gateway.assetCatalog();
    const out: Row[] = [];
    for (const e of catalog) {
      if (assetKindToType(e.kind) !== assetType) continue;
      out.push({ guid: e.guid, kind: e.kind, name: e.name ?? e.guid });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [assetType]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.guid.toLowerCase().includes(q));
  }, [rows, query]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    setFocused((i) => Math.min(Math.max(i, 0), Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  const commit = (guid: string) => { onPick(guid); onClose(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setFocused((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocused((i) => (filtered.length === 0 ? 0 : (i <= 0 ? filtered.length - 1 : i - 1))); }
    else if (e.key === 'Enter') { e.preventDefault(); const row = filtered[focused]; if (row) commit(row.guid); }
  };

  return (
    <div
      className="asset-picker-backdrop"
      data-testid="asset-picker"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        className="asset-picker"
        role="dialog"
        aria-label={`Select ${assetType}`}
        onKeyDown={onKeyDown}
        style={{ width: 340, maxHeight: '70vh', display: 'flex', flexDirection: 'column', background: 'var(--bg1, #23262b)', border: '1px solid var(--line, #3a3f46)', borderRadius: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden' }}
      >
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line, #3a3f46)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg, #e6e6e6)' }}>Select {assetType}</span>
          <button type="button" className="asset-clear" data-testid="asset-picker-close" title="close (Esc)" onClick={onClose}>×</button>
        </div>
        <div style={{ padding: 8, borderBottom: '1px solid var(--line, #3a3f46)' }}>
          <input
            ref={inputRef}
            type="text"
            data-testid="asset-picker-search"
            value={query}
            placeholder={`Search ${rows.length} ${assetType}…`}
            onChange={(e) => { setQuery(e.target.value); setFocused(0); }}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 6px' }}
          />
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {onClear && (
            <button type="button" data-testid="asset-picker-none" onClick={() => { onClear(); onClose(); }} style={rowStyle(!currentGuid, false)}>
              <span style={{ width: 20, height: 20, minWidth: 20, borderRadius: 3, border: '1px dashed var(--line, #3a3f46)' }} />
              <span style={{ flex: 1, fontSize: 12, color: 'var(--fg3, #9aa0a6)' }}>None (unbind)</span>
            </button>
          )}
          {filtered.length === 0 && (
            <div data-testid="asset-picker-empty" style={{ padding: 16, textAlign: 'center', color: 'var(--fg3, #9aa0a6)', fontSize: 12 }}>
              {rows.length === 0 ? `No ${assetType} in project` : `No matches for "${query}"`}
            </div>
          )}
          {filtered.map((r, i) => (
            <PickerRow key={r.guid} row={r} active={r.guid === currentGuid} focused={i === focused} onHover={() => setFocused(i)} onClick={() => commit(r.guid)} />
          ))}
        </div>
        <div style={{ padding: '4px 10px', borderTop: '1px solid var(--line, #3a3f46)', fontSize: 10, color: 'var(--fg3, #9aa0a6)' }}>
          ↑↓ navigate · ⏎ select · Esc close
        </div>
      </div>
    </div>
  );
}

function rowStyle(active: boolean, focused: boolean): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 10px',
    border: 'none', borderLeft: active ? '2px solid var(--accent, #6ab0ff)' : '2px solid transparent',
    background: focused ? 'var(--bg3, #2c3138)' : 'transparent', cursor: 'pointer', textAlign: 'left',
  };
}

function PickerRow({ row, active, focused, onHover, onClick }: { row: Row; active: boolean; focused: boolean; onHover: () => void; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={`asset-picker-row-${row.guid}`}
      onMouseEnter={onHover}
      onClick={onClick}
      title={`${row.name}\n${row.kind} · ${row.guid}`}
      style={rowStyle(active, focused)}
    >
      <Swatch guid={row.guid} kind={row.kind} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--fg, #e6e6e6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.name}
      </span>
      {active && <span style={{ fontSize: 11, color: 'var(--accent, #6ab0ff)' }}>✓</span>}
    </button>
  );
}
