import * as React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

/**
 * Self-contained, Ant-Design-style dropdown select. Replaces the previous
 * `@radix-ui/react-select` wrapper (whose scroll-button chrome — the stray up/
 * down carets and the hidden native scrollbar — read as non-standard here).
 *
 * Design:
 *   - Compound API kept byte-compatible with the old Radix wrapper
 *     (`Select` / `SelectTrigger` / `SelectValue` / `SelectContent` /
 *     `SelectItem` / …) so existing call sites need no changes.
 *   - Options are DERIVED from the declarative `<SelectItem>` children (walked
 *     once per render) so the trigger can render the selected item's label
 *     WITHOUT opening, and search has the full option set up front.
 *   - `showSearch` UX: the SEARCH IS THE TRIGGER. When open + searchable, the
 *     trigger turns into a text input; typing there filters the list. The popup
 *     holds ONLY the option list (no separate search box).
 *   - The popup is portaled to <body>, fixed-positioned under the trigger, and
 *     FLIPS above when there isn't enough room below. Native scrollbar
 *     (`overflow-y: auto`) — no custom scroll buttons.
 *   - No global `window`/`document` listeners: dismissal uses a transparent
 *     in-portal backdrop, keyboard is handled by element-level `onKeyDown`.
 *   - `data-state` / `data-highlighted` / `role="option"` mirror the old Radix
 *     markup so existing panel skins (`.fx-insp-menu [role="option"]`, …) work.
 */

const AUTO_SEARCH_THRESHOLD = 8;

// ── option extraction ────────────────────────────────────────────────────────
interface OptionMeta {
  value: string;
  label: React.ReactNode;
  text: string;
  search: string;
  disabled: boolean;
  className?: string;
  size?: SelectSize;
  domProps: Record<string, unknown>;
}

/** Flatten any ReactNode into its plain-text content (for search + placeholder). */
function nodeToText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (React.isValidElement(node)) return nodeToText((node.props as { children?: React.ReactNode }).children);
  return '';
}

function pickDomProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(props)) {
    if (k.startsWith('data-') || k.startsWith('aria-') || k === 'title' || k === 'id') out[k] = props[k];
  }
  return out;
}

function collectOptions(children: React.ReactNode, acc: OptionMeta[]): void {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const type = child.type as { __fxSelectItem?: boolean } | undefined;
    if (type?.__fxSelectItem) {
      const p = child.props as SelectItemProps;
      const text = nodeToText(p.children) || String(p.value);
      acc.push({
        value: String(p.value),
        label: p.children,
        text,
        search: text.toLowerCase(),
        disabled: !!p.disabled,
        className: p.className,
        size: p.size,
        domProps: pickDomProps(p as unknown as Record<string, unknown>),
      });
      return;
    }
    const nested = (child.props as { children?: React.ReactNode })?.children;
    if (nested != null) collectOptions(nested, acc);
  });
}

// ── context ──────────────────────────────────────────────────────────────────
type SelectSize = 'sm' | 'default' | 'lg';

interface SelectCtx {
  value: string | undefined;
  options: OptionMeta[];
  filtered: OptionMeta[];
  open: boolean;
  setOpen: (o: boolean) => void;
  select: (v: string) => void;
  disabled: boolean;
  searchable: boolean;
  searchPlaceholder: string;
  emptyText: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  query: string;
  setQuery: (q: string) => void;
  active: number;
  setActive: (i: number) => void;
  moveActive: (delta: number) => void;
  onNavKeyDown: (e: React.KeyboardEvent) => void;
}
const Ctx = React.createContext<SelectCtx | null>(null);
function useSelectCtx(component: string): SelectCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error(`<${component}> must be used within <Select>`);
  return ctx;
}

// ── root ─────────────────────────────────────────────────────────────────────
export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  /** true = always show search, false = never, undefined = auto (long lists). */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  children?: React.ReactNode;
}

function Select({
  value: valueProp,
  defaultValue,
  onValueChange,
  disabled = false,
  searchable,
  searchPlaceholder = 'Search…',
  emptyText = 'No results',
  children,
}: SelectProps) {
  const [open, setOpenState] = React.useState(false);
  const [internal, setInternal] = React.useState<string | undefined>(defaultValue);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const value = valueProp !== undefined ? valueProp : internal;

  const options = React.useMemo(() => {
    const acc: OptionMeta[] = [];
    collectOptions(children, acc);
    return acc;
  }, [children]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.search.includes(q));
  }, [options, query]);

  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next);
    if (next) {
      setQuery('');
      setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    }
  }, [options, value]);

  const select = React.useCallback((v: string) => {
    if (valueProp === undefined) setInternal(v);
    onValueChange?.(v);
    setOpenState(false);
  }, [valueProp, onValueChange]);

  const moveActive = React.useCallback((delta: number) => {
    setActive((a) => {
      const n = filtered.length;
      if (n === 0) return 0;
      let next = a;
      for (let i = 0; i < n; i++) {
        next = (next + delta + n) % n;
        if (!filtered[next]?.disabled) break;
      }
      return next;
    });
  }, [filtered]);

  const onNavKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpenState(false); return; }
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[active];
      if (opt && !opt.disabled) select(opt.value);
    }
  }, [open, filtered, active, moveActive, select, setOpen]);

  const resolvedSearchable = searchable ?? options.length >= AUTO_SEARCH_THRESHOLD;

  const ctx: SelectCtx = {
    value, options, filtered, open, setOpen, select, disabled,
    searchable: resolvedSearchable, searchPlaceholder, emptyText, triggerRef,
    query, setQuery, active, setActive, moveActive, onNavKeyDown,
  };
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

// ── trigger (doubles as the search input when open + searchable) ───────────────
const selectTriggerVariants = cva(
  'no-motion-lift relative flex w-full cursor-pointer appearance-none items-center justify-between whitespace-nowrap rounded-md border border-input bg-[var(--color-background-base)] text-foreground shadow-sm outline-none transition-colors hover:border-[var(--color-border-strong)] focus:outline-none focus-visible:outline-none data-[state=open]:border-[var(--color-border-strong)] disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'h-9 px-3 py-2 text-sm',
        sm: 'h-7 px-2 py-1 text-xs',
        lg: 'h-10 px-3 py-2 text-sm',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof selectTriggerVariants>
>(({ className, children, size, onClick, ...props }, ref) => {
  const ctx = useSelectCtx('SelectTrigger');
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const searching = ctx.open && ctx.searchable;
  const selected = ctx.options.find((o) => o.value === ctx.value);

  // Focus the inline search input as soon as it appears.
  React.useEffect(() => {
    if (searching) inputRef.current?.focus();
  }, [searching]);

  const setRefs = (node: HTMLButtonElement | null): void => {
    ctx.triggerRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = node;
  };
  return (
    <button
      ref={setRefs}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={ctx.open}
      disabled={ctx.disabled}
      data-state={ctx.open ? 'open' : 'closed'}
      className={cn(selectTriggerVariants({ size }), className)}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented && !ctx.disabled) ctx.setOpen(!ctx.open);
      }}
      onKeyDown={ctx.onNavKeyDown}
      {...props}
    >
      {searching ? (
        <input
          ref={inputRef}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-inherit shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0"
          style={{ outline: 'none', boxShadow: 'none' }}
          placeholder={selected ? selected.text : ctx.searchPlaceholder}
          value={ctx.query}
          // Keep the popup's toggle out of the way while typing.
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { ctx.setQuery(e.target.value); ctx.setActive(0); }}
          onKeyDown={ctx.onNavKeyDown}
        />
      ) : (
        children
      )}
      <ChevronDown
        aria-hidden
        className={cn('ml-1 h-4 w-4 shrink-0 opacity-50 transition-transform', ctx.open && 'rotate-180')}
      />
    </button>
  );
});
SelectTrigger.displayName = 'SelectTrigger';

// ── value (selected label; shown when NOT searching) ───────────────────────────
const SelectValue = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & { placeholder?: React.ReactNode }
>(({ className, placeholder, ...props }, ref) => {
  const ctx = useSelectCtx('SelectValue');
  const selected = ctx.options.find((o) => o.value === ctx.value);
  const empty = selected == null;
  return (
    <span
      ref={ref}
      className={cn('pointer-events-none block min-w-0 flex-1 truncate text-left', empty && 'text-muted-foreground', className)}
      {...props}
    >
      {empty ? placeholder ?? '' : selected.label}
    </span>
  );
});
SelectValue.displayName = 'SelectValue';

// ── content (portaled popup with smart flip) ───────────────────────────────────
interface PopupStyle { left: number; width: number; maxHeight: number; placement: 'bottom' | 'top'; anchor: number }

const POPUP_DESIRED_HEIGHT = 320;

function computePopup(trigger: HTMLElement): PopupStyle {
  const r = trigger.getBoundingClientRect();
  const gap = 4;
  const margin = 8; // keep the panel off the viewport edge
  const vh = window.innerHeight;
  const below = vh - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  // Prefer opening downward; flip up only when it can't fit below AND there is
  // more room above. maxHeight never exceeds the available space, so the panel
  // can't overflow off-screen (it scrolls internally instead).
  const placeTop = below < POPUP_DESIRED_HEIGHT && above > below;
  const space = Math.max(0, placeTop ? above : below);
  return {
    left: Math.round(r.left),
    width: Math.round(r.width),
    maxHeight: Math.min(POPUP_DESIRED_HEIGHT, Math.floor(space)),
    placement: placeTop ? 'top' : 'bottom',
    // distance from the viewport edge the panel is anchored to
    anchor: placeTop ? Math.round(vh - r.top + gap) : Math.round(r.bottom + gap),
  };
}

const selectItemRowVariants = cva(
  'relative flex w-full cursor-pointer select-none items-center rounded-sm text-left outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
  {
    variants: {
      size: {
        default: 'py-1.5 pl-2 pr-8 text-sm',
        sm: 'py-1 pl-2 pr-7 text-xs',
        lg: 'py-2 pl-2 pr-8 text-sm',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

const SelectContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { position?: string }
>(({ className, position: _position, ...props }, ref) => {
  const ctx = useSelectCtx('SelectContent');
  const { open, filtered, value, select, active } = ctx;
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const activeRowRef = React.useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = React.useState<PopupStyle | null>(null);

  // Position once on open (no scroll/resize listeners by design).
  React.useLayoutEffect(() => {
    if (!open) { setStyle(null); return; }
    const trigger = ctx.triggerRef.current;
    if (trigger) setStyle(computePopup(trigger));
  }, [open, ctx.triggerRef]);

  // Keep the keyboard-highlighted row in view.
  React.useEffect(() => {
    if (open) activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open || !style) return null;

  return createPortal(
    <>
      {/* transparent dismiss layer — replaces a global outside-click listener */}
      <div
        className="fixed inset-0 z-[var(--z-menu)]"
        onPointerDown={() => ctx.setOpen(false)}
      />
      <div
        ref={(node) => {
          panelRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        role="listbox"
        data-state="open"
        data-placement={style.placement}
        className={cn(
          'fx-select-panel fixed z-[var(--z-menu)] flex flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-xl',
          className,
        )}
        style={{
          left: style.left,
          width: style.width,
          minWidth: style.width,
          ...(style.placement === 'top'
            ? { bottom: style.anchor }
            : { top: style.anchor }),
        }}
        onKeyDown={ctx.onNavKeyDown}
        {...props}
      >
        <div className="fx-select-viewport min-h-0 flex-1 overflow-y-auto py-1" style={{ maxHeight: style.maxHeight }}>
          {filtered.length === 0 ? (
            <div className="fx-select-empty px-2 py-4 text-center text-xs text-muted-foreground">{ctx.emptyText}</div>
          ) : (
            filtered.map((opt, i) => {
              const checked = opt.value === value;
              const highlighted = i === active;
              return (
                <div
                  key={opt.value}
                  ref={highlighted ? activeRowRef : undefined}
                  role="option"
                  aria-selected={checked}
                  data-state={checked ? 'checked' : 'unchecked'}
                  data-highlighted={highlighted ? '' : undefined}
                  data-disabled={opt.disabled || undefined}
                  className={cn(
                    selectItemRowVariants({ size: opt.size }),
                    highlighted && 'bg-[var(--color-interaction-hover)] text-foreground',
                    checked && 'data-[state=checked]:bg-[var(--color-interaction-selected-neutral)]',
                    opt.className,
                  )}
                  onPointerEnter={() => { if (!opt.disabled) ctx.setActive(i); }}
                  onClick={() => { if (!opt.disabled) select(opt.value); }}
                  {...opt.domProps}
                >
                  <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                    {checked && <Check className="h-4 w-4" />}
                  </span>
                  <span className="block truncate">{opt.label}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>,
    document.body,
  );
});
SelectContent.displayName = 'SelectContent';

// ── item (declarative option; rendered by SelectContent, not by itself) ────────
export interface SelectItemProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  disabled?: boolean;
  size?: SelectSize;
}
const SelectItem: React.FC<SelectItemProps> & { __fxSelectItem?: boolean } = () => null;
SelectItem.displayName = 'SelectItem';
SelectItem.__fxSelectItem = true;

// ── structural passthroughs (kept for API compatibility) ───────────────────────
const SelectGroup = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const SelectLabel = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-2 py-1.5 text-sm font-semibold', className)} {...props} />
);
const SelectSeparator = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('-mx-1 my-1 h-px bg-muted', className)} {...props} />
);
/** Deprecated no-ops — the native scrollbar replaces Radix's scroll buttons. */
const SelectScrollUpButton = (): null => null;
const SelectScrollDownButton = (): null => null;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
