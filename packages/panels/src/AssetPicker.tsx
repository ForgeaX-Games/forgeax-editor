// AssetPicker — UE-style anchored asset browser for Inspector asset fields.
// Portaled to document.body with adaptive above/below placement.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { gateway } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ForgeaxIcon, AssetThumbnail } from '@forgeax/editor-ui';
import { readRuntimeAssetCatalog } from './runtime-asset-catalog';
import {
  computeAssetPickerPlacement,
  type AssetPickerAnchor,
} from './asset-picker-placement';
import './inspector.css';

export type { AssetPickerAnchor } from './asset-picker-placement';
export { anchorFromElement } from './asset-picker-placement';

export interface AssetPickerProps {
  assetType: string;
  currentGuid?: string | null;
  /** Anchor rect from the invoking asset-ref control; defaults to a viewport fallback. */
  anchor?: AssetPickerAnchor | null;
  onPick: (guid: string) => void;
  onClear?: () => void;
  onClose: () => void;
}

interface Row {
  guid: string;
  kind: string;
  name: string;
  packageUrl: string;
}

function baseName(path: string | undefined): string {
  if (!path) return '';
  const last = path.split('/').pop() ?? '';
  return last.replace(/\.(pack\.json|meta\.json)$/i, '').replace(/\.[^.]+$/, '');
}

function catalogEntryName(e: { name?: string; guid: string; kind: string; packageUrl: string; sourcePath?: string }): string {
  if (e.name && e.name.trim()) return e.name.trim();
  return baseName(e.sourcePath) || baseName(e.packageUrl) || `${e.kind} ${e.guid.slice(0, 8)}`;
}

function Swatch({ guid, kind, packageUrl }: { guid: string; kind: string; packageUrl?: string }) {
  const described = gateway.describeAssetByGuid(guid);
  const meta = described?.ok ? (described.meta as Record<string, unknown> | undefined) : undefined;
  return <AssetThumbnail kind={kind} payload={meta} packPath={packageUrl} size={24} />;
}

const FALLBACK_ANCHOR: AssetPickerAnchor = { top: 120, bottom: 152, left: 240, right: 560, width: 320, height: 32 };

function PickerRow({
  row,
  active,
  focused,
  onHover,
  onClick,
}: {
  row: Row;
  active: boolean;
  focused: boolean;
  onHover: () => void;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={`fx-asset-picker-row${active ? ' active' : ''}${focused ? ' focused' : ''}`}
      data-testid={`asset-picker-row-${row.guid}`}
      onMouseEnter={onHover}
      onClick={onClick}
      title={`${row.name}\n${row.kind} · ${row.guid}`}
    >
      <span className="fx-asset-picker-row-thumb">
        <Swatch guid={row.guid} kind={row.kind} packageUrl={row.packageUrl} />
      </span>
      <span className="fx-asset-picker-row-name">{row.name}</span>
    </button>
  );
}

export function AssetPicker({
  assetType,
  currentGuid,
  anchor,
  onPick,
  onClear,
  onClose,
}: AssetPickerProps): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState(() => computeAssetPickerPlacement(anchor ?? FALLBACK_ANCHOR));

  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    let cancelled = false;
    void readRuntimeAssetCatalog(assetType).then((catalog) => {
      if (cancelled) return;
      const out = catalog.map((entry) => ({
        guid: entry.guid,
        kind: entry.kind,
        name: catalogEntryName(entry),
        packageUrl: entry.packageUrl,
      }));
      out.sort((left, right) => left.name.localeCompare(right.name));
      setRows(out);
    }).catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
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

  useLayoutEffect(() => {
    const resolved = anchor ?? FALLBACK_ANCHOR;
    const measured = panelRef.current?.offsetHeight ?? placement.maxHeight;
    setPlacement(computeAssetPickerPlacement(resolved, measured));
  }, [anchor, filtered.length, query, placement.maxHeight]);

  const commit = (guid: string) => { onPick(guid); onClose(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setFocused((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocused((i) => (filtered.length === 0 ? 0 : (i <= 0 ? filtered.length - 1 : i - 1))); }
    else if (e.key === 'Enter') { e.preventDefault(); const row = filtered[focused]; if (row) commit(row.guid); }
  };

  return createPortal(
    <>
      <div className="fx-asset-picker-backdrop" onMouseDown={onClose} />
      <div
        ref={panelRef}
        className={`fx-asset-picker fx-asset-picker--${placement.placement}`}
        data-testid="asset-picker"
        role="listbox"
        aria-label={t('editor.inspector.assetPicker.browseSection')}
        style={{
          top: placement.top,
          left: placement.left,
          width: placement.width,
          minHeight: placement.minHeight,
          height: placement.maxHeight,
          maxHeight: placement.maxHeight,
        }}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="fx-asset-picker-section">
          <div className="fx-asset-picker-section-label">{t('editor.inspector.assetPicker.browseSection')}</div>
          <div className="fx-asset-picker-search">
            <ForgeaxIcon name="search" size={13} />
            <input
              ref={inputRef}
              type="text"
              data-testid="asset-picker-search"
              value={query}
              placeholder={t('editor.inspector.assetPicker.searchPlaceholder')}
              onChange={(e) => { setQuery(e.target.value); setFocused(0); }}
            />
          </div>
        </div>
        <div className="fx-asset-picker-list-head">
          <ForgeaxIcon name="layers" size={12} />
          <span>{t('editor.inspector.assetPicker.nameColumn')}</span>
        </div>
        <div className="fx-asset-picker-list">
          {onClear && (
            <button
              type="button"
              className="fx-asset-picker-row fx-asset-picker-row-none"
              data-testid="asset-picker-none"
              onClick={() => { onClear(); onClose(); }}
            >
              <span className="fx-asset-picker-row-thumb empty" />
              <span className="fx-asset-picker-row-name">{t('editor.inspector.assetPicker.none')}</span>
            </button>
          )}
          {filtered.length === 0 && (
            <div className="fx-asset-picker-empty" data-testid="asset-picker-empty">
              {rows.length === 0
                ? t('editor.inspector.assetPicker.emptyType', { assetType })
                : t('editor.inspector.assetPicker.emptyQuery', { query })}
            </div>
          )}
          {filtered.map((row, index) => (
            <PickerRow
              key={row.guid}
              row={row}
              active={row.guid === currentGuid}
              focused={index === focused}
              onHover={() => setFocused(index)}
              onClick={() => commit(row.guid)}
            />
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}
