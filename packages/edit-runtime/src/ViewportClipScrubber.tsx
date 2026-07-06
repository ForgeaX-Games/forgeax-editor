// ViewportClipScrubber — animation playhead for the scene viewport.
//
// Re-homed from the former socket editor (feedback 2026-06-30: "唯一该留的是 scene
// 视口的动画 clip scrubber"). Drives the preview character's AnimationPlayer via
// editor-core's clip-control transport (cross-window-bridged in store.ts; the
// AnimationPlayer lives in the MAIN world, wired in main.tsx). Lets the user pause
// on any frame and scrub to calibrate poses (e.g. placing a prop as a ChildOf of a
// bone via the Hierarchy + Transform panels).
//
// Bottom-center overlay, mirroring ViewportBar's chrome. Purely transport UI — no
// socket/prop concept; prop-to-bone attachment is plain scene hierarchy now.

import { setClipControl, useClipControl, requestView } from '@forgeax/editor-core';

export function ViewportClipScrubber() {
  const clip = useClipControl();
  return (
    <div className="vp-clip" data-testid="viewport-clip-scrubber">
      <button
        type="button"
        className={`vp-btn${clip.paused ? '' : ' on'}`}
        data-testid="vp-clip-play"
        title={clip.paused ? '播放动画' : '暂停动画'}
        onClick={() => setClipControl({ paused: !clip.paused, applyPhase: false })}
      >
        {clip.paused ? '▶' : '⏸'}
      </button>
      <input
        type="range"
        className="vp-clip-range"
        data-testid="vp-clip-phase"
        min={0}
        max={1}
        step={0.001}
        value={clip.phase}
        title="逐帧标定：拖动定位到任意帧"
        onChange={(e) => setClipControl({ phase: Number(e.target.value), paused: true, applyPhase: true })}
      />
      <span className="vp-clip-val" data-testid="vp-clip-phase-val">{(clip.phase * 100).toFixed(0)}%</span>
      <span className="vp-sep" />
      <span className="vp-clip-lbl">速度</span>
      <input
        type="range"
        className="vp-clip-range vp-clip-speed"
        data-testid="vp-clip-speed"
        min={0}
        max={3}
        step={0.05}
        value={clip.speed}
        title="播放速度"
        onChange={(e) => setClipControl({ speed: Number(e.target.value), applyPhase: false })}
      />
      <span className="vp-clip-val">{clip.speed.toFixed(2)}×</span>
      <span className="vp-sep" />
      <button
        type="button"
        className="vp-btn"
        data-testid="vp-clip-recenter"
        title="角色归一化：缩放到标准身高并居中落地"
        onClick={() => requestView('recenter')}
      >
        ⌖
      </button>
      <button
        type="button"
        className="vp-btn"
        data-testid="vp-clip-resetcam"
        title="重置相机到默认取景"
        onClick={() => requestView('resetCamera')}
      >
        ⟲
      </button>
    </div>
  );
}
