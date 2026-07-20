import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Rocket, Globe, Monitor, Laptop, Smartphone, Wrench, History, Eraser, Lightbulb, MousePointerClick,
} from 'lucide-react';
import { PUBLISH_OPTIONS, publishDoc } from './publish-options';
import './PublishOnboarding.css';

type T = (key: string, opts?: Record<string, string | number>) => string;

interface Step {
  id: string;
  sel: string;
  place: 'below' | 'left';
  /** Whether the dropdown must be open for this step's anchor to exist. */
  menu: boolean;
  finger?: boolean;
  icon: ReactNode;
  title: string;
  desc: string;
  hint: string;
}

// tip title reuses the menu label; icon mirrors the menu item's icon.
const LABEL_KEY: Record<string, string> = {
  web: 'platformWeb', windows: 'platformWindows', macos: 'platformMac', android: 'platformAndroid',
  engine: 'rebuildEngine', history: 'history', clean: 'clean',
};
function optionIcon(id: string): ReactNode {
  const sz = 24;
  switch (id) {
    case 'web': return <Globe size={sz} />;
    case 'windows': return <Monitor size={sz} />;
    case 'macos': return <Laptop size={sz} />;
    case 'android': return <Smartphone size={sz} />;
    case 'engine': return <Wrench size={sz} />;
    case 'history': return <History size={sz} />;
    case 'clean': return <Eraser size={sz} />;
    default: return <Rocket size={sz} />;
  }
}

function buildSteps(t: T): Step[] {
  const intro: Step = {
    id: 'intro', sel: '.tb-publish-btn', place: 'below', menu: false, finger: true,
    icon: <MousePointerClick size={24} />,
    title: t('topbar.onboard.introTitle'),
    desc: t('topbar.onboard.introDesc'),
    hint: t('topbar.onboard.introHint'),
  };
  const opts = PUBLISH_OPTIONS.filter((o) => !o.gray).map<Step>((o) => {
    const d = publishDoc(t, o.id);
    return {
      id: o.id, sel: `[data-onboard="${o.id}"]`, place: 'left', menu: true,
      icon: optionIcon(o.id),
      title: t(`topbar.package.${LABEL_KEY[o.id] ?? o.id}`),
      desc: d.what, hint: d.when,
    };
  });
  return [intro, ...opts];
}

interface Geometry {
  spot: { top: number; left: number; width: number; height: number };
  tip: { top: number; left: number };
  arrow: 'up' | 'right';
  arrowPos: number;
  finger?: { left: number; top: number };
}

const TIP_W = 300;
const TIP_H_EST = 175;
const PAD = 6;

function compute(el: HTMLElement, step: Step): Geometry {
  const r = el.getBoundingClientRect();
  const spot = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
  if (step.place === 'below') {
    const left = Math.max(12, r.right - TIP_W);
    const arrowPos = Math.min(TIP_W - 24, Math.max(16, r.left + r.width / 2 - left));
    return {
      spot, arrow: 'up', arrowPos,
      tip: { left, top: r.bottom + 16 },
      finger: step.finger ? { left: r.left + r.width / 2 - 12, top: r.bottom + 2 } : undefined,
    };
  }
  const top = Math.max(12, Math.min(window.innerHeight - TIP_H_EST - 12, r.top + r.height / 2 - TIP_H_EST / 2));
  const arrowPos = Math.min(TIP_H_EST - 24, Math.max(16, r.top + r.height / 2 - top));
  return { spot, arrow: 'right', arrowPos, tip: { left: r.left - TIP_W - 20, top } };
}

export interface PublishOnboardingProps {
  active: boolean;
  onClose: () => void;
  setMenuOpen: (open: boolean) => void;
  t: T;
}

export function PublishOnboarding({ active, onClose, setMenuOpen, t }: PublishOnboardingProps) {
  const steps = useMemo(() => buildSteps(t), [t]);
  const optionTotal = steps.filter((s) => s.id !== 'intro').length;
  const [idx, setIdx] = useState(0);
  const [geo, setGeo] = useState<Geometry | null>(null);

  useEffect(() => { if (active) { setIdx(0); setGeo(null); } }, [active]);

  const step = steps[idx];

  // Drive the real dropdown: open it for option steps, close for the intro.
  useEffect(() => {
    if (!active || !step) return;
    setMenuOpen(step.menu);
  }, [active, idx, step, setMenuOpen]);

  const measure = useCallback((): boolean => {
    if (!step) return false;
    const el = document.querySelector(step.sel) as HTMLElement | null;
    if (!el) return false;
    setGeo(compute(el, step));
    return true;
  }, [step]);

  // The Radix menu items mount in a portal a tick after we request open, so
  // retry measuring a few times before giving up.
  useLayoutEffect(() => {
    if (!active || !step) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const run = () => { if (measure()) return; if (tries++ < 12) timer = setTimeout(run, 45); };
    timer = setTimeout(run, step.menu ? 150 : 20);
    return () => clearTimeout(timer);
  }, [active, idx, step, measure]);

  const finish = useCallback(() => { setMenuOpen(false); onClose(); }, [onClose, setMenuOpen]);
  // Decide advance-vs-finish in the event handler, NOT inside the setIdx
  // updater — React runs updaters during render, so calling finish() (which
  // setState()s the parent TopBar) from there triggers a "setState while
  // rendering a different component" warning.
  const next = useCallback(() => {
    if (idx >= steps.length - 1) finish();
    else setIdx((i) => i + 1);
  }, [idx, steps.length, finish]);
  const prev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!active) return;
    const onResize = () => measure();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'Escape') finish();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('keydown', onKey); };
  }, [active, measure, next, prev, finish]);

  if (!active || !geo || !step) return null;

  const isLast = idx >= steps.length - 1;
  const isOption = step.id !== 'intro';
  const optNum = isOption ? steps.slice(0, idx + 1).filter((s) => s.id !== 'intro').length : 0;

  return createPortal(
    <>
      <div className="fx-ob-blocker" onClick={(e) => e.stopPropagation()} />
      <div
        className="fx-ob-spot"
        style={{ top: geo.spot.top, left: geo.spot.left, width: geo.spot.width, height: geo.spot.height }}
      />
      {geo.finger && (
        <div className="fx-ob-finger" style={{ left: geo.finger.left, top: geo.finger.top }}>
          <svg viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 9 5 12 1.8-5.2L21 14Z" /><path d="M7.2 2.2 8 5.1" /><path d="m5.1 8-2.9-.8" /><path d="M14 4.1 12 6" /><path d="m6 12-1.9 2" />
          </svg>
        </div>
      )}
      <div className="fx-ob-tip" data-arrow={geo.arrow} style={{ top: geo.tip.top, left: geo.tip.left }}>
        <span
          className="fx-ob-arrow"
          style={geo.arrow === 'up' ? { left: geo.arrowPos } : { top: geo.arrowPos }}
        />
        <div className="fx-ob-em">{step.icon}</div>
        <div className="fx-ob-title">{step.title}</div>
        <p className="fx-ob-desc">{step.desc}</p>
        {step.hint && (
          <p className="fx-ob-hint"><Lightbulb size={13} /><span>{step.hint}</span></p>
        )}
        <div className="fx-ob-foot">
          {isOption && <span className="fx-ob-count">{t('topbar.onboard.counter', { n: optNum, total: optionTotal })}</span>}
          <span className="fx-ob-grow" />
          <button type="button" className="fx-ob-btn ghost" onClick={finish}>{t('topbar.onboard.skip')}</button>
          {idx > 0 && <button type="button" className="fx-ob-btn" onClick={prev}>{t('topbar.onboard.prev')}</button>}
          <button type="button" className="fx-ob-btn primary" onClick={next}>
            {isLast ? <><Rocket size={14} />{t('topbar.onboard.done')}</> : t('topbar.onboard.next')}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
