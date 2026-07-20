import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import {
  listExtensions,
  pickLang,
  type ExtensionInfo,
  type ExtensionListResponse,
} from '../../lib/extension-api';

// P4.79 · break the 13-tick CSS-only pearl/decoration streak by surfacing
// a previously invisible backend island: /api/extensions/list counts. The
// server has exposed Bus.plugins.list() since P2.6a (commit aa5ee13) but
// the player has never seen the data outside the BusAdminPanel (which is
// closed by default). This badge anchors itself fixed bottom-right of the
// viewport so it is unconditionally visible on every page/mode, fetches
// /api/extensions/list once on mount, and renders a compact pill with total
// count + kind breakdown (workbench / cli-provider / agent / model /
// skill / tool / etc). All styles are inline so no CSS file (interface
// dirty storm in full effect) is touched. New directory under src/components/
// — no `M` or `??` collision per the don't-touch-player-untracked-dirs rule.

interface KindBreakdown {
  workbench: number;
  agent: number;
  cliProvider: number;
  model: number;
  skill: number;
  tool: number;
  other: number;
}

function tallyByKind(items: ExtensionListResponse['items']): KindBreakdown {
  const counts: KindBreakdown = {
    workbench: 0,
    agent: 0,
    cliProvider: 0,
    model: 0,
    skill: 0,
    tool: 0,
    other: 0,
  };
  for (const p of items) {
    switch (p.kind) {
      case 'workbench':
        counts.workbench++;
        break;
      case 'agent':
        counts.agent++;
        break;
      case 'cli-provider':
        counts.cliProvider++;
        break;
      case 'model':
      case 'model-binding':
        counts.model++;
        break;
      case 'skill':
        counts.skill++;
        break;
      case 'tool':
        counts.tool++;
        break;
      default:
        counts.other++;
    }
  }
  return counts;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ok'; total: number; kinds: KindBreakdown; items: ExtensionInfo[] }
  | { status: 'error'; message: string };

const KIND_ORDER: Array<{ key: string; label: string; match: (p: ExtensionInfo) => boolean }> = [
  { key: 'workbench', label: 'workbench', match: (p) => p.kind === 'workbench' },
  { key: 'agent', label: 'agent', match: (p) => p.kind === 'agent' },
  { key: 'cli-provider', label: 'cli-provider', match: (p) => p.kind === 'cli-provider' },
  { key: 'model', label: 'model', match: (p) => p.kind === 'model' || p.kind === 'model-binding' },
  { key: 'skill', label: 'skill', match: (p) => p.kind === 'skill' },
  { key: 'tool', label: 'tool', match: (p) => p.kind === 'tool' },
];

function groupByKind(items: ExtensionInfo[]): Array<{ label: string; rows: ExtensionInfo[] }> {
  const used = new Set<ExtensionInfo>();
  const groups = KIND_ORDER.map(({ label, match }) => {
    const rows = items.filter((p) => match(p));
    rows.forEach((r) => used.add(r));
    return { label, rows };
  }).filter((g) => g.rows.length > 0);
  const rest = items.filter((p) => !used.has(p));
  if (rest.length > 0) groups.push({ label: 'other', rows: rest });
  return groups;
}

export function BuildBadge() {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    listExtensions()
      .then((res) => {
        if (cancelled) return;
        setState({
          status: 'ok',
          total: res.count,
          kinds: tallyByKind(res.items),
          items: res.items,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', message: msg });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const interactive = state.status === 'ok';
  const wrapStyle: CSSProperties = {
    position: 'fixed',
    right: 8,
    bottom: 8,
    zIndex: 'var(--z-menu)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 9px 4px 7px',
    borderRadius: 999,
    background: open ? 'rgba(28, 34, 40, 0.92)' : 'rgba(20, 24, 28, 0.78)',
    color: 'var(--fg-2)',
    fontSize: 11,
    lineHeight: 1.2,
    fontFamily: 'var(--mono, var(--font-mono))',
    letterSpacing: 0.2,
    pointerEvents: 'auto',
    userSelect: 'none',
    cursor: interactive ? 'pointer' : 'default',
    boxShadow: open
      ? 'inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -1px 1px rgba(0,0,0,0.35), 0 0 0 1px rgba(212,255,72,0.42)'
      : 'inset 0 1px 0 rgba(255,255,255,0.06), inset 0 -1px 1px rgba(0,0,0,0.30), 0 0 0 1px rgba(212,255,72,0.18)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    transition: 'background 120ms ease, box-shadow 120ms ease',
  };
  const dotStyle: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background:
      state.status === 'ok'
        ? 'rgba(212,255,72,0.95)'
        : state.status === 'loading'
          ? 'rgba(180,180,180,0.6)'
          : 'rgba(255,90,90,0.9)',
    boxShadow:
      state.status === 'ok'
        ? '0 0 6px rgba(212,255,72,0.55)'
        : 'none',
    flexShrink: 0,
  };
  const labelStyle: CSSProperties = {
    color: 'rgba(212,255,72,0.92)',
    fontWeight: 600,
  };
  const sepStyle: CSSProperties = {
    color: 'rgba(255,255,255,0.18)',
    margin: '0 2px',
  };
  const kindSpan: CSSProperties = {
    color: 'rgba(220,228,235,0.85)',
  };

  let title = 'forgeax · bus plugins';
  let content: ReactNode;
  if (state.status === 'loading') {
    content = <span style={kindSpan}>bus · loading…</span>;
    title = 'forgeax · /api/extensions/list loading…';
  } else if (state.status === 'error') {
    content = (
      <>
        <span style={kindSpan}>bus offline</span>
      </>
    );
    title = `forgeax · /api/extensions/list error: ${state.message}`;
  } else {
    const k = state.kinds;
    const parts: string[] = [];
    if (k.workbench) parts.push(`${k.workbench}wb`);
    if (k.agent) parts.push(`${k.agent}ag`);
    if (k.cliProvider) parts.push(`${k.cliProvider}cli`);
    if (k.model) parts.push(`${k.model}mdl`);
    if (k.skill) parts.push(`${k.skill}sk`);
    if (k.tool) parts.push(`${k.tool}tl`);
    if (k.other) parts.push(`${k.other}·`);
    content = (
      <>
        <span style={kindSpan}>{state.total} plugins</span>
        {parts.length > 0 && (
          <>
            <span style={sepStyle}>·</span>
            <span style={kindSpan}>{parts.join(' ')}</span>
          </>
        )}
      </>
    );
    title = `forgeax · ${state.total} plugins live on Bus · ${parts.join(' / ')}`;
  }

  const popoverStyle: CSSProperties = {
    position: 'absolute',
    right: 0,
    bottom: 'calc(100% + 6px)',
    minWidth: 260,
    maxWidth: 340,
    maxHeight: 380,
    overflowY: 'auto',
    background: 'rgba(14, 18, 22, 0.94)',
    border: '1px solid rgba(212,255,72,0.22)',
    borderRadius: 8,
    boxShadow:
      '0 10px 28px rgba(0,0,0,0.50), inset 0 1px 0 rgba(255,255,255,0.05), 0 0 0 1px rgba(212,255,72,0.10)',
    padding: '8px 10px 10px',
    fontSize: 11,
    color: 'rgba(220,228,235,0.92)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    pointerEvents: 'auto',
    cursor: 'default',
  };
  const groupHeadStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    margin: '6px 0 2px',
    color: 'rgba(212,255,72,0.78)',
    fontWeight: 600,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  };
  const groupCountStyle: CSSProperties = {
    color: 'rgba(255,255,255,0.32)',
    fontWeight: 400,
  };
  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    padding: '2px 0',
    lineHeight: 1.35,
  };
  const rowIconStyle: CSSProperties = {
    width: 14,
    display: 'inline-block',
    textAlign: 'center',
    color: 'rgba(212,255,72,0.85)',
  };
  const rowNameStyle: CSSProperties = { color: 'rgba(232,238,244,0.92)' };
  const rowIdStyle: CSSProperties = {
    color: 'rgba(255,255,255,0.28)',
    fontSize: 10,
    marginLeft: 'auto',
    paddingLeft: 8,
    fontFamily: 'inherit',
  };
  const popHeaderStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    margin: '0 0 4px',
    paddingBottom: 4,
    borderBottom: '1px solid rgba(212,255,72,0.12)',
  };
  const popHintStyle: CSSProperties = {
    color: 'rgba(255,255,255,0.38)',
    fontSize: 10,
  };

  const onBadgeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (interactive) setOpen((o) => !o);
  };

  return (
    <div
      ref={wrapRef}
      className="forgeax-build-badge"
      data-bus-status={state.status}
      data-open={open ? 'true' : 'false'}
      style={wrapStyle}
      title={title}
      role={interactive ? 'button' : undefined}
      aria-expanded={interactive ? open : undefined}
      tabIndex={interactive ? 0 : -1}
      onClick={onBadgeClick}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen((o) => !o);
        }
      }}
    >
      <span style={dotStyle} aria-hidden />
      <span style={labelStyle}>forgeax</span>
      <span style={sepStyle}>·</span>
      {content}
      {open && state.status === 'ok' && (
        <div
          className="forgeax-build-badge-popover"
          data-open="true"
          style={popoverStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={popHeaderStyle}>
            <span style={{ ...labelStyle, fontSize: 11 }}>
              {state.total} bus plugins
            </span>
            <span style={popHintStyle}>esc to close</span>
          </div>
          {groupByKind(state.items).map((g) => (
            <div key={g.label}>
              <div style={groupHeadStyle}>
                <span>{g.label}</span>
                <span style={groupCountStyle}>{g.rows.length}</span>
              </div>
              {g.rows.map((p) => {
                const name = pickLang(p.displayName, locale, p.id);
                const icon =
                  p.icon ??
                  p.workbench?.icon ??
                  (p.kind === 'cli-provider' ? '⌘' : p.kind === 'agent' ? '◆' : '·');
                const shortId = p.id.replace(/^@forgeax-plugin\//, '');
                return (
                  <div key={p.id} style={rowStyle} data-extension-id={p.id}>
                    <span style={rowIconStyle} aria-hidden>
                      {icon}
                    </span>
                    <span style={rowNameStyle}>{name}</span>
                    <span style={rowIdStyle}>{shortId}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
