import { useEffect, useRef, useState } from 'react';
import { bus, dispatch, setAnimPreview, useDocVersion, useSelection } from '@forgeax/editor-shared';
import { type Clip, type Interp, type Track, emptyClip, sampleClip, setKey, removeKey } from '@forgeax/editor-core';

// Timeline panel (design EDITOR-MODE P2/P3) — keyframe animation for the selected
// entity. The clip lives on an `Anim` component (duration + tracks) authored via
// the command bus (undoable, AI-symmetric); the renderer ignores `Anim` so it's
// pure authoring data. Scrubbing/playing publishes a sampled pose to the viewport
// (setAnimPreview) which applies it live to the entity — what you scrub is what it
// looks like. Capture (K) snapshots the entity's current Transform into keys at the
// playhead; interpolation is per-key linear/step/smooth (see core/anim.ts).

const CAPTURE = ['x', 'y', 'z', 'rotY']; // channels the K button snapshots
const numv = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round = (x: number): number => Math.round(x * 100) / 100;

export function TimelinePanel() {
  useDocVersion();
  const sel = useSelection();
  const node = sel !== null ? bus.doc.entities[sel] : undefined;
  const raw = node?.components.Anim as { duration?: number; tracks?: Track[] } | undefined;
  const clip: Clip = raw && Array.isArray(raw.tracks) ? { duration: numv(raw.duration, 4), tracks: raw.tracks } : emptyClip();
  const dur = Math.max(0.001, clip.duration);

  const [time, setTime] = useState(0);
  const [interp, setInterp] = useState<Interp>('linear');
  const [playing, setPlaying] = useState(false);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const prevSel = useRef(sel);

  // clear the live preview when switching entity or unmounting (the viewport then
  // resyncs the previous entity back to its doc pose).
  useEffect(() => { if (prevSel.current !== sel) { setAnimPreview(null); prevSel.current = sel; setTime(0); setPlaying(false); } }, [sel]);
  useEffect(() => () => setAnimPreview(null), []);
  // push the sampled pose to the viewport whenever the playhead moves.
  useEffect(() => { if (sel !== null) setAnimPreview(sel, sampleClip(clip, time)); }, [time, sel]); // eslint-disable-line react-hooks/exhaustive-deps
  // play loop: advance the playhead, looping at the clip duration.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const start = performance.now() - time * 1000;
    const tick = (): void => { setTime(((performance.now() - start) / 1000) % dur); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, dur]); // eslint-disable-line react-hooks/exhaustive-deps

  if (sel === null || !node) {
    return <div className="panel ed-timeline" data-testid="panel-timeline"><h3>Timeline</h3><div className="muted tl-empty">选中一个实体以编辑动画。</div></div>;
  }

  const writeClip = (c: Clip): void => {
    const data = { duration: c.duration, tracks: c.tracks };
    if (node.components.Anim) dispatch({ kind: 'setComponent', entity: sel, component: 'Anim', patch: data });
    else dispatch({ kind: 'addComponent', entity: sel, component: 'Anim', value: data });
  };
  const capture = (): void => {
    const t = (node.components.Transform as Record<string, number> | undefined) ?? {};
    let c = clip;
    for (const k of CAPTURE) c = setKey(c, `Transform.${k}`, { t: round(time), v: numv(t[k], k.startsWith('scale') ? 1 : 0), interp });
    writeClip(c);
  };
  const removeAt = (): void => { let c = clip; for (const tr of clip.tracks) c = removeKey(c, tr.channel, round(time)); writeClip(c); };

  const scrubTo = (clientX: number): void => {
    const r = laneRef.current?.getBoundingClientRect();
    if (!r) return;
    setPlaying(false);
    setTime(round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * dur));
  };
  const onLaneDown = (e: React.PointerEvent): void => {
    scrubTo(e.clientX);
    const mv = (ev: PointerEvent): void => scrubTo(ev.clientX);
    const up = (): void => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const pct = (t: number): string => `${(t / dur) * 100}%`;

  return (
    <div className="panel ed-timeline" data-testid="panel-timeline">
      <h3>Timeline · {node.name}</h3>
      <div className="tl-toolbar">
        <button type="button" className="tl-btn" data-testid="tl-play" onClick={() => setPlaying((p) => !p)} title={playing ? '暂停' : '播放预览'}>{playing ? '⏸' : '▶'}</button>
        <button type="button" className="tl-btn" data-testid="tl-key" onClick={capture} title="在播放头记录当前 Transform 关键帧">● K</button>
        <button type="button" className="tl-btn" onClick={removeAt} title="删除播放头处的关键帧">✖ K</button>
        <select className="tl-interp" value={interp} onChange={(e) => setInterp(e.target.value as Interp)} title="新关键帧的插值方式">
          <option value="linear">linear</option>
          <option value="step">step</option>
          <option value="smooth">smooth</option>
        </select>
        <span className="tl-sp" />
        <label className="tl-dur">时长
          <input type="number" min={0.1} step={0.1} value={clip.duration} onChange={(e) => writeClip({ ...clip, duration: Math.max(0.1, Number(e.target.value) || 0.1) })} />s
        </label>
        <span className="tl-time">{time.toFixed(2)}s</span>
      </div>

      <div className="tl-lane-wrap">
        <div className="tl-ruler" ref={laneRef} onPointerDown={onLaneDown}>
          <div className="tl-playhead" style={{ left: pct(time) }} />
        </div>
        {clip.tracks.length === 0 ? (
          <div className="muted tl-hint">移动实体到某帧 → 按「● K」记录关键帧；多帧之间自动插值。</div>
        ) : (
          clip.tracks.map((tr) => (
            <div className="tl-track" key={tr.channel}>
              <span className="tl-ch" title={tr.channel}>{tr.channel.replace('Transform.', '')}</span>
              <div className="tl-keys">
                {tr.keys.map((k) => (
                  <span key={k.t} className={`tl-key i-${k.interp ?? 'linear'}`} style={{ left: pct(k.t) }} title={`t=${k.t}s v=${k.v} (${k.interp ?? 'linear'}) — 单击跳到此帧`}
                    onClick={() => { setPlaying(false); setTime(k.t); }} />
                ))}
                <div className="tl-playhead thin" style={{ left: pct(time) }} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
