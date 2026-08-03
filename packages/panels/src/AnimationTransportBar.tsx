// AnimationTransportBar — the bespoke Inspector preview transport for
// AnimationPlayer (animation-preview M1).
//
// Play/pause · phase scrub · speed for the primary clip slot. Every control
// dispatches the ONE session op (setAnimationPreview) through the gateway — no
// direct world writes here (north-star §2: write = dispatch). Field names come
// from the component's reflected playback contract (getTransportDescriptor),
// so the bar carries zero AnimationPlayer-specific field knowledge.
//
// Preview writes are session state: the op snapshots the declared runtime
// fields before the first write and the save/play/selection-change boundaries
// restore them — scrubbing never pollutes the saved scene.

import { useEffect, useReducer } from 'react';
import { entComponent, gateway, getTransportDescriptor } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ForgeaxIcon } from '@forgeax/editor-ui';
import type { BespokeEditorProps } from './bespoke-editors';

const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2];

function readNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  return [];
}

export default function AnimationTransportBar({ entity, component }: BespokeEditorProps) {
  const { t } = useTranslation();
  const descriptor = getTransportDescriptor(component);
  // Live phase follows playback — poll while mounted (Inspector-scale cheap).
  const [, force] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    const timer = setInterval(force, 150);
    return () => clearInterval(timer);
  }, []);

  if (descriptor === undefined) return null;
  const cur = entComponent(gateway.activeWorld, entity, component);
  const data = cur.ok ? (cur.value as Record<string, unknown>) : undefined;

  const slot = descriptor.clipIndex;
  const clips = readNumberArray(data?.[descriptor.clips]);
  const times = readNumberArray(data?.[descriptor.times]);
  const speeds = readNumberArray(data?.[descriptor.speeds]);
  const paused = data?.[descriptor.paused] !== false;

  const clipHandle = clips[slot] ?? 0;
  let duration = 0;
  if (clipHandle > 0) {
    const resolved = gateway.resolveAsset(clipHandle);
    if (resolved.ok) {
      const d = (resolved.asset as { duration?: unknown }).duration;
      if (typeof d === 'number' && d > 0) duration = d;
    }
  }
  const hasClip = duration > 0;
  const phase = hasClip ? Math.max(0, Math.min(1, (times[slot] ?? 0) / duration)) : 0;
  const speed = speeds[slot] ?? 1;
  const speedOptions = SPEED_OPTIONS.includes(speed) ? SPEED_OPTIONS : [...SPEED_OPTIONS, speed].sort((a, b) => a - b);

  const dispatchPreview = (patch: { playing?: boolean; speed?: number; phase?: number }): void => {
    gateway.dispatch({ kind: 'setAnimationPreview', entity, ...patch });
  };

  return (
    <div className="anim-transport" data-testid={`anim-transport-${component}`}>
      <button
        type="button"
        className="anim-toggle"
        data-testid="anim-play-toggle"
        disabled={!hasClip}
        title={!hasClip ? t('editor.inspector.animNoClip') : paused ? t('editor.inspector.animPlay') : t('editor.inspector.animPause')}
        onClick={() => dispatchPreview({ playing: paused })}
      >
        <ForgeaxIcon name={paused ? 'play' : 'pause'} size={12} />
      </button>
      <input
        type="range"
        className="anim-phase"
        data-testid="anim-phase"
        title={t('editor.inspector.animPhase')}
        min={0}
        max={1}
        step={0.001}
        value={phase}
        disabled={!hasClip}
        onChange={(e) => dispatchPreview({ phase: Number(e.target.value) })}
      />
      <select
        className="anim-speed"
        data-testid="anim-speed"
        title={t('editor.inspector.animSpeed')}
        value={String(speed)}
        disabled={!hasClip}
        onChange={(e) => dispatchPreview({ speed: Number(e.target.value) })}
      >
        {speedOptions.map((s) => (
          <option key={s} value={String(s)}>{s}×</option>
        ))}
      </select>
      {!hasClip && (
        <span className="anim-hint" data-testid="anim-no-clip">{t('editor.inspector.animNoClip')}</span>
      )}
    </div>
  );
}
