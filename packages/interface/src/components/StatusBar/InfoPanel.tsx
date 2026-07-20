/**
 * InfoPanel — a standalone, dockable Blender-INFO-editor-style log panel.
 *
 * Registered as an OPTIONAL dock panel (id 'info' in panelRegistry.tsx) so the
 * user can open / dock / pop it out like Preview / Edit / Console. Content is
 * the same health feed the bottom HealthStatusBar peeks at, but full-height and
 * with the affordances Blender's INFO editor has:
 *
 *   - one row per entry: severity icon + time + source badge + message, newest
 *     at the bottom, auto-scrolled to the latest;
 *   - CLICK A ROW to copy its full text (source · time · message) to the
 *     clipboard, with a brief "copied" flash;
 *   - consecutive identical entries fold into ONE row + an `×N` count badge so a
 *     flood (e.g. `PickError ... has no Camera component`) occupies one line;
 *   - severity / source filters + a copy-all + clear button.
 *
 * Pure presentation over healthStore — no engine coupling.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Info, CheckCircle2, AlertTriangle, XCircle, Trash2, Copy, Check } from 'lucide-react';
import { useTranslation } from '@/i18n';
import {
  useHealthStore,
  collapseEntries,
  entryToText,
  type HealthEntry,
  type HealthLevel,
  type HealthSource,
  type CollapsedEntry,
} from './healthStore';
import './InfoPanel.css';

const ICONS: Record<HealthLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
};

const LEVELS: HealthLevel[] = ['info', 'success', 'warn', 'error'];
const SOURCES: HealthSource[] = ['play', 'edit', 'plugin', 'shell', 'engine'];

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function CopyRow({
  ce,
  latest,
  onCopy,
  copied,
}: {
  ce: CollapsedEntry;
  latest: boolean;
  onCopy: (ce: CollapsedEntry) => void;
  copied: boolean;
}) {
  const { t } = useTranslation();
  const { entry, count } = ce;
  const Icon = ICONS[entry.level];
  return (
    <div
      className={`ip-row ip-row--${entry.level}${latest ? ' ip-row--latest' : ''}${copied ? ' ip-row--copied' : ''}`}
      data-code={entry.code}
      role="button"
      tabIndex={0}
      title={t('infoPanel.clickToCopy')}
      onClick={() => onCopy(ce)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCopy(ce);
        }
      }}
    >
      <Icon className="ip-icon" size={13} />
      <span className="ip-time">{fmtTime(entry.ts)}</span>
      <span className={`ip-source ip-source--${entry.source}`}>{entry.source}</span>
      <span className="ip-msg">{entry.message}</span>
      {count > 1 && <span className="ip-count" title={t('infoPanel.repeatedTimes', { count })}>×{count}</span>}
      <span className="ip-copy-hint">{copied ? <Check size={12} /> : <Copy size={12} />}</span>
    </div>
  );
}

export function InfoPanel() {
  const { t } = useTranslation();
  const entries = useHealthStore((s) => s.entries);
  const clear = useHealthStore((s) => s.clear);
  const listRef = useRef<HTMLDivElement | null>(null);
  // key of the row most recently copied → flashes a "copied" state briefly.
  const [copiedKey, setCopiedKey] = useState<number | null>(null);
  const [allCopied, setAllCopied] = useState(false);

  // Severity / source filters. null entries mean "show all of that axis".
  const [levelFilter, setLevelFilter] = useState<Set<HealthLevel>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<Set<HealthSource>>(new Set());

  const filtered = useMemo(() => {
    if (levelFilter.size === 0 && sourceFilter.size === 0) return entries;
    return entries.filter(
      (e) =>
        (levelFilter.size === 0 || levelFilter.has(e.level)) &&
        (sourceFilter.size === 0 || sourceFilter.has(e.source)),
    );
  }, [entries, levelFilter, sourceFilter]);

  // Fold consecutive identical entries into ×N rows.
  const collapsed = useMemo(() => collapseEntries(filtered), [filtered]);

  // Auto-scroll to newest whenever the visible set grows.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [collapsed.length, entries.length]);

  const copyText = (text: string): void => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard may be unavailable (insecure ctx) — fail silently */
    }
  };

  const handleCopyRow = (ce: CollapsedEntry): void => {
    copyText(entryToText(ce.entry, ce.count));
    setCopiedKey(ce.key);
    window.setTimeout(() => setCopiedKey((k) => (k === ce.key ? null : k)), 900);
  };

  const handleCopyAll = (): void => {
    const text = collapsed.map((ce) => entryToText(ce.entry, ce.count)).join('\n');
    copyText(text);
    setAllCopied(true);
    window.setTimeout(() => setAllCopied(false), 900);
  };

  const toggleLevel = (l: HealthLevel) =>
    setLevelFilter((s) => {
      const n = new Set(s);
      n.has(l) ? n.delete(l) : n.add(l);
      return n;
    });
  const toggleSource = (src: HealthSource) =>
    setSourceFilter((s) => {
      const n = new Set(s);
      n.has(src) ? n.delete(src) : n.add(src);
      return n;
    });

  return (
    <div className="info-panel">
      <div className="ip-toolbar">
        <div className="ip-filters">
          {LEVELS.map((l) => {
            const Icon = ICONS[l];
            return (
              <button
                key={l}
                type="button"
                className={`ip-filter ip-filter--${l}${levelFilter.has(l) ? ' on' : ''}`}
                title={t('infoPanel.filterLevel', { level: l })}
                onClick={() => toggleLevel(l)}
              >
                <Icon size={12} />
              </button>
            );
          })}
          <span className="ip-filter-sep" />
          {SOURCES.map((src) => (
            <button
              key={src}
              type="button"
              className={`ip-filter ip-filter--src ip-source--${src}${sourceFilter.has(src) ? ' on' : ''}`}
              title={t('infoPanel.filterSource', { source: src })}
              onClick={() => toggleSource(src)}
            >
              {src}
            </button>
          ))}
        </div>
        <span className="ip-spacer" />
        <button type="button" className="ip-tb-btn" title={t('infoPanel.copyAll')} onClick={handleCopyAll} disabled={collapsed.length === 0}>
          {allCopied ? <Check size={13} /> : <Copy size={13} />} {t('infoPanel.copyAll')}
        </button>
        <button type="button" className="ip-tb-btn" title={t('infoPanel.clear')} onClick={() => clear()} disabled={entries.length === 0}>
          <Trash2 size={13} /> {t('infoPanel.clear')}
        </button>
      </div>

      <div className="ip-list thin-scrollbar" ref={listRef} role="log" aria-live="polite" aria-label="forgeax INFO log">
        {collapsed.length === 0 && (
          <div className="ip-empty">
            {entries.length === 0
              ? t('infoPanel.emptyNoMessages')
              : t('infoPanel.emptyNoMatch')}
          </div>
        )}
        {collapsed.map((ce, i) => (
          <CopyRow
            key={ce.key}
            ce={ce}
            latest={i === collapsed.length - 1}
            onCopy={handleCopyRow}
            copied={copiedKey === ce.key}
          />
        ))}
      </div>
    </div>
  );
}
