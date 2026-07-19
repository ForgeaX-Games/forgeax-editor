import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Eye, EyeOff, Loader2, Search } from 'lucide-react';
import { useTranslation } from '@/i18n';
import type { ModelCatalogEntry } from '../../lib/model-config';
import { setAgentModels, setModelHidden } from '../../lib/model-config';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useModelCatalog } from './useModelCatalog';
import './ModelPicker.css';

export interface ModelPickerWriteTarget {
  sid: string;
  agentPath: string;
}

interface BaseProps {
  variant?: 'button' | 'pill' | 'inline';
  /** When set in single mode, after onChange the picker writes the new selection
   *  to agent.json::models.model via set_agent_models. Multi mode ignores this. */
  writeToAgent?: ModelPickerWriteTarget | null;
  /** Decorate the right side of each row (per-model status badges, etc.). */
  rowBadge?: (m: ModelCatalogEntry) => ReactNode;
  className?: string;
  /** Fallback label shown in 'button' / 'pill' variants when value is empty. */
  fallbackLabel?: string;
  /** Single-mode trigger text override (e.g. compact "Opus 4.7" in Composer). */
  displayLabel?: string;
  /** Tooltip shown on hover of the trigger button in 'button' / 'pill' variants. */
  triggerTitle?: string;
  /** Disable the picker (button stays visible but unclickable). */
  disabled?: boolean;
  disabledReason?: string;
  /** Optional runtime/provider catalog scope, e.g. cursor-agent driver models. */
  providerId?: string | null;
}

interface SingleProps extends BaseProps {
  mode?: 'single';
  value: string | null;
  onChange: (next: string | null) => void;
}

interface MultiProps extends BaseProps {
  mode: 'multi';
  value: Set<string>;
  onChange: (next: Set<string>) => void;
}

export type ModelPickerProps = SingleProps | MultiProps;

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  return `${Math.round(n / 1000)}K`;
}

function ModelRowBadges({ m }: { m: ModelCatalogEntry }) {
  return (
    <>
      {typeof m.contextWindow === 'number' && (
        <>
          <span className="mp-sep" aria-hidden="true">·</span>
          <span className="mp-ctx" title={`contextWindow=${m.contextWindow}`}>
            {formatContext(m.contextWindow)}
          </span>
        </>
      )}
      {m.reasoning && <span className="mp-reasoning" title="reasoning supported">reasoning</span>}
      {Array.isArray(m.input) && m.input.length > 0 && (
        <span className="mp-modalities">
          {m.input.map((mod) => (
            <span key={mod} className={`mp-modality r-${mod}`}>{mod}</span>
          ))}
        </span>
      )}
    </>
  );
}

export function ModelPicker(props: ModelPickerProps) {
  const { t } = useTranslation();
  const {
    variant = 'button',
    writeToAgent = null,
    rowBadge,
    className,
    fallbackLabel,
    triggerTitle,
    disabled = false,
    disabledReason,
    providerId = null,
  } = props;
  const mode = props.mode ?? 'single';

  const { models, driver, error, refresh } = useModelCatalog(providerId);
  const [open, setOpen] = useState(variant === 'inline');
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(-1);
  const [opInFlight, setOpInFlight] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isMulti = mode === 'multi';
  const singleValue = (!isMulti ? (props as SingleProps).value : null);
  const multiValue = (isMulti ? (props as MultiProps).value : null);

  // Hidden models are filtered out of the single-mode (Composer/TopBar) dropdown
  // entirely — that's the "Settings 决定哪些可选" 行为. multi+inline (ModelLab +
  // Settings → Models) keeps everything so the user can un-hide.
  const showHidden = isMulti || variant === 'inline';

  const filtered = useMemo(() => {
    const list = models ?? [];
    const post = showHidden ? list : list.filter((m) => !m.hidden);
    const q = query.trim().toLowerCase();
    if (!q) return post;
    return post.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, query, showHidden]);

  // The server returns the catalog already strongest-first (claude → version
  // desc). When live is authoritative it IS the live set — disk only annotates
  // metadata, so disk/live are not split. Rented CLI driver catalogs are the
  // only separate group because they have different metering semantics.
  const grouped = useMemo(() => {
    const gateway = filtered.filter((m) => m.source !== 'driver');
    const driver = filtered.filter((m) => m.source === 'driver');
    return { gateway, driver };
  }, [filtered]);

  const flat = useMemo(() => [...grouped.gateway, ...grouped.driver], [grouped]);

  // Outside-click / Esc / open-focus are owned by Radix Popover now (button &
  // pill variants). We only reset transient menu state when it closes.
  useEffect(() => {
    if (variant === 'inline') return;
    if (!open) {
      setFocused(-1);
      setQuery('');
    }
  }, [open, variant]);

  // Keyboard navigation: ↑↓ to move focus, ⏎ to commit. (Esc handled by Popover.)
  useEffect(() => {
    if (!open && variant !== 'inline') return;
    const onKey = (e: KeyboardEvent) => {
      const total = flat.length;
      if (total === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocused((i) => (i < 0 ? 0 : (i + 1) % total));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocused((i) => (i <= 0 ? total - 1 : i - 1));
      } else if (e.key === 'Enter') {
        if (focused < 0 || focused >= total) return;
        const m = flat[focused];
        if (!m) return;
        e.preventDefault();
        void commit(m.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, variant, flat, focused]);

  const commit = async (modelId: string) => {
    if (disabled) return;
    if (isMulti) {
      const set = new Set(multiValue ?? []);
      if (set.has(modelId)) set.delete(modelId);
      else set.add(modelId);
      (props as MultiProps).onChange(set);
      return;
    }
    // Single mode: optionally write to agent.json before notifying caller.
    if (writeToAgent && singleValue !== modelId) {
      if (opInFlight) return;
      setOpInFlight(modelId);
      try {
        const res = await setAgentModels(writeToAgent.sid, writeToAgent.agentPath, [modelId]);
        (props as SingleProps).onChange(res.selected ?? modelId);
        setOpen(false);
      } catch (err) {
        // Surface the server message string — an Error object serializes to `{}`
        // in the console-warn → log pipeline, which was hiding the real cause
        // (e.g. "set_agent_models: agent path not found in tree: <path>").
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[model-picker] set_agent_models failed: ${msg}`, { modelId, agentPath: writeToAgent.agentPath, sid: writeToAgent.sid });
        // Still close — the trigger label keeps the prior selection so the user
        // sees the write didn't land.
        setOpen(false);
      } finally {
        setOpInFlight(null);
      }
      return;
    }
    (props as SingleProps).onChange(modelId);
    setOpen(false);
  };

  const displayLabel = !isMulti ? (props as SingleProps).displayLabel : undefined;
  const triggerLabel = isMulti
    ? `${multiValue?.size ?? 0} selected`
    : (displayLabel ?? singleValue ?? fallbackLabel ?? 'pick model');

  // Trigger badge shows the count user sees in the dropdown — hidden are
  // excluded for single-mode pickers.
  const total = (models ?? []).filter((m) => showHidden || !m.hidden).length;

  const toggleHidden = async (m: ModelCatalogEntry) => {
    if (opInFlight) return;
    setOpInFlight(m.id);
    try {
      await setModelHidden(m.id, !m.hidden);
      await refresh();
    } catch (err) {
      console.warn('[model-picker] set_model_hidden failed', { id: m.id, err });
    } finally {
      setOpInFlight(null);
    }
  };

  const renderRow = (m: ModelCatalogEntry, i: number) => {
    const isCurrent = isMulti
      ? (multiValue?.has(m.id) ?? false)
      : (singleValue === m.id);
    const inflight = opInFlight === m.id;
    return (
      <button
        key={m.id}
        type="button"
        role={isMulti ? 'menuitemcheckbox' : 'menuitem'}
        aria-checked={isMulti ? isCurrent : undefined}
        aria-current={!isMulti && isCurrent ? 'true' : undefined}
        className={`mp-item${focused === i ? ' is-focused' : ''}${isCurrent ? ' is-current' : ''}`}
        onMouseEnter={() => setFocused(i)}
        onClick={() => void commit(m.id)}
        data-testid={`model-picker-row-${m.id}`}
      >
        {isMulti && (
          <span className="mp-check" aria-hidden="true">
            <input type="checkbox" checked={isCurrent} readOnly tabIndex={-1} />
          </span>
        )}
        <span className={`mp-id${m.hidden ? ' is-hidden-model' : ''}`}>{m.id}</span>
        <ModelRowBadges m={m} />
        {m.live && <span className="mp-live" title="served by the LiteLLM /v1/models proxy">live</span>}
        {m.source === 'driver' && (
          <span
            className="mp-driver"
            title={`${m.driverLabel ?? m.driverId ?? 'driver'} · subscription runtime · no local cost metering`}
          >
            driver
          </span>
        )}
        {m.source !== 'driver' && m.live && <span className="mp-live" title="served by the LiteLLM /v1/models proxy">live</span>}
        {m.hidden && <span className="mp-hidden-tag" title="hidden from Composer picker">hidden</span>}
        <span className="mp-tail">
          {rowBadge ? rowBadge(m) : null}
          {!rowBadge && !isMulti && isCurrent && <span className="mp-arrow" title="current">✓</span>}
          {!rowBadge && !isMulti && inflight && <Loader2 size={11} className="mp-spin" />}
          {showHidden && (
            <button
              type="button"
              className="mp-eye"
              title={m.hidden ? t('modelPicker.showInComposer') : t('modelPicker.hideFromComposer')}
              aria-label={m.hidden ? 'show in picker' : 'hide from picker'}
              data-testid={`model-picker-eye-${m.id}`}
              disabled={inflight}
              onClick={(e) => { e.stopPropagation(); void toggleHidden(m); }}
            >
              {m.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          )}
        </span>
      </button>
    );
  };

  const renderMenu = () => (
    <div
      className={`mp-menu${variant === 'inline' ? ' mp-menu-inline' : ' mp-menu--popover'}`}
      role="menu"
      aria-label="Model picker"
      data-testid="model-picker-menu"
    >
      <div className="mp-search">
        <Search size={12} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={`Search ${total} models…`}
          onChange={(e) => { setQuery(e.target.value); setFocused(0); }}
          aria-label="Filter models"
          data-testid="model-picker-search"
        />
        <button
          type="button"
          className="mp-refresh"
          title="refetch list_models"
          onClick={() => void refresh()}
        >↻</button>
      </div>
      {error && <div className="mp-err">{error}</div>}
      {!models && !error && <div className="mp-loading">loading…</div>}
      {/* 内核目录不可用(回退链全部落空,source='none'):显式空态 + 失败原因,
          绝不展示假列表;trigger 上保留用户已选模型不受影响。 */}
      {models && flat.length === 0 && !query && driver?.source === 'none' && (
        <div className="mp-empty mp-unavailable" data-testid="model-picker-unavailable" title={driver.error}>
          <div>catalog unavailable for {driver.id}</div>
          {driver.error && <div className="mp-unavailable-detail">{driver.error}</div>}
        </div>
      )}
      {models && flat.length === 0 && !(driver?.source === 'none' && !query) && (
        <div className="mp-empty">{query ? `no matches for "${query}"` : 'catalog empty'}</div>
      )}
      {grouped.gateway.map((m, i) => renderRow(m, i))}
      {grouped.driver.length > 0 && (
        <>
          <div className="mp-group" aria-hidden="true">
            {grouped.driver[0]?.driverLabel ?? 'driver'} · {grouped.driver.length} · no local cost
            {/* 非实时来源徽章:last-known = 上次成功探测的缓存;static = 内核预置表 */}
            {(driver?.source === 'last-known' || driver?.source === 'static') && (
              <span
                className="mp-stale"
                data-testid="model-picker-stale-badge"
                title={driver.source === 'last-known'
                  ? `cached from the last successful fetch${driver.error ? ` — live fetch failed: ${driver.error}` : ''}`
                  : `kernel-declared static defaults${driver.error ? ` — discovery failed: ${driver.error}` : ''}`}
              >
                {driver.source === 'last-known' ? 'cached' : 'preset'}
              </span>
            )}
          </div>
          {grouped.driver.map((m, i) => renderRow(m, grouped.gateway.length + i))}
        </>
      )}
      <div className="mp-foot">
        ↑↓ navigate · ⏎ {isMulti ? 'toggle' : 'select'} · Esc close
      </div>
    </div>
  );

  if (variant === 'inline') {
    return (
      <div ref={rootRef} className={`mp-root mp-inline${className ? ' ' + className : ''}`}>
        {renderMenu()}
      </div>
    );
  }

  const triggerCls = variant === 'pill' ? 'mp-trigger mp-pill' : 'mp-trigger mp-button';
  return (
    <div ref={rootRef} className={`mp-root${className ? ' ' + className : ''}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`${triggerCls}${open ? ' is-open' : ''}`}
            disabled={disabled}
            title={disabled ? (disabledReason ?? triggerTitle) : triggerTitle}
            data-testid="model-picker-trigger"
          >
            <span className="mp-trigger-label">{triggerLabel}</span>
            <ChevronDown size={11} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={4}
          className="w-auto border-0 bg-transparent p-0 shadow-none"
        >
          {renderMenu()}
        </PopoverContent>
      </Popover>
    </div>
  );
}
