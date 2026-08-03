// session/animation-preview-ops — the setAnimationPreview session op (M1).
//
// One op drives an entity's AnimationPlayer playback transport for Inspector
// preview — play/pause, speed, phase scrub — the same op the human transport
// bar and an AI both dispatch (registry razor). SESSION-domain: ledger-only,
// no undo (preview is session state, not authored intent).
//
// Everything field-specific comes from the component's reflected playback
// contract (meta.animation: engine meta long-term, editor overlay interim):
//   - transport field names (clips/times/speeds/paused + primary clipIndex)
//   - runtimeFields the first preview write snapshots (save-pollution defense,
//     session/animation-preview.ts)
//
// The applier writes through ctx.engine (the ONLY engine write door for a
// session op) and resolves the bound clip's duration through ctx.resolveAsset
// (bound to the dispatching gateway's active world — no singleton import).

import { resolveComponent } from '@forgeax/engine-ecs';
import { registerApplier } from '../io/appliers';
import type { SessionApplier, SessionApplierCtx } from '../io/appliers';
import { getComponentSchema } from '../scene/schema';
import type { CommandError, EditorOp } from '../types';
import { snapshotAnimationPreview } from './animation-preview';

const COMPONENT = 'AnimationPlayer';

type ApplierResult = { ok: true } | { ok: false; error: CommandError };

const fail = (code: CommandError['code'], hint: string): ApplierResult => ({ ok: false, error: { code, hint } });
const invalidArgs = (hint: string): ApplierResult => fail('INVALID_ARGS', hint);

function readNumberArray(value: unknown): number[] | null {
  if (Array.isArray(value)) return [...value] as number[];
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  return null;
}

/** The bound clip's duration in seconds, or null when the primary slot is
 *  empty / the handle does not resolve / the payload carries no duration. */
function clipDurationSec(ctx: SessionApplierCtx, clipsValue: unknown, clipIndex: number): number | null {
  const clips = readNumberArray(clipsValue);
  const handle = clips?.[clipIndex];
  if (typeof handle !== 'number' || handle <= 0) return null;
  if (ctx.resolveAsset === undefined) return null;
  const r = ctx.resolveAsset(handle);
  if (!r.ok) return null;
  const duration = (r.asset as { duration?: unknown }).duration;
  return typeof duration === 'number' && duration > 0 ? duration : null;
}

function applySetAnimationPreview(op: EditorOp, ctx?: SessionApplierCtx): ApplierResult {
  const { entity, playing, speed, phase } = op as {
    entity?: unknown; playing?: unknown; speed?: unknown; phase?: unknown;
  };
  if (typeof entity !== 'number') return invalidArgs('setAnimationPreview requires a numeric `entity` handle');
  if (playing === undefined && speed === undefined && phase === undefined) {
    return invalidArgs('setAnimationPreview requires at least one of playing/speed/phase');
  }
  if (playing !== undefined && typeof playing !== 'boolean') return invalidArgs('`playing` must be a boolean');
  if (speed !== undefined && (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0 || speed > 10)) {
    return invalidArgs('`speed` must be a number in 0..10');
  }
  if (phase !== undefined && (typeof phase !== 'number' || !Number.isFinite(phase) || phase < 0 || phase > 1)) {
    return invalidArgs('`phase` must be a number in 0..1');
  }
  const engine = ctx?.engine;
  if (engine === undefined || ctx === undefined) {
    return fail('WORLD_UNAVAILABLE', 'setAnimationPreview needs the session applier engine-write context');
  }

  const transport = getComponentSchema(COMPONENT)?.animation?.transport;
  if (transport === undefined) {
    return fail('UNKNOWN_COMPONENT', `${COMPONENT} declares no playback transport (meta.animation missing — editor overlay or engine meta)`);
  }
  const token = resolveComponent(COMPONENT);
  if (token === undefined) {
    return fail('UNKNOWN_COMPONENT', `${COMPONENT} is not registered in the engine`);
  }
  const cur = engine.get(entity, token) as { ok: boolean; value?: Record<string, unknown> };
  if (!cur.ok || cur.value === undefined) {
    return fail('NO_SUCH_COMPONENT', `entity ${entity} has no ${COMPONENT}`);
  }

  // Build the full patch BEFORE snapshotting/writing so a validation failure
  // (unbound clip for a scrub) neither snapshots nor half-writes (AC-6).
  const patch: Record<string, unknown> = {};
  if (playing !== undefined) patch[transport.paused] = !playing;
  if (speed !== undefined) {
    const speeds = readNumberArray(cur.value[transport.speeds]);
    if (speeds === null) return invalidArgs(`${COMPONENT}.${transport.speeds} is not readable as an array`);
    while (speeds.length <= transport.clipIndex) speeds.push(1);
    speeds[transport.clipIndex] = speed;
    patch[transport.speeds] = speeds;
  }
  if (phase !== undefined) {
    const duration = clipDurationSec(ctx, cur.value[transport.clips], transport.clipIndex);
    if (duration === null) {
      return fail('ASSET_NOT_FOUND', `phase scrub needs a clip bound at ${COMPONENT}.${transport.clips}[${transport.clipIndex}] with a resolvable duration — bind an animation-clip first`);
    }
    const times = readNumberArray(cur.value[transport.times]);
    if (times === null) return invalidArgs(`${COMPONENT}.${transport.times} is not readable as an array`);
    while (times.length <= transport.clipIndex) times.push(0);
    times[transport.clipIndex] = phase * duration;
    patch[transport.times] = times;
  }

  // First preview write on this entity snapshots the reflection-declared
  // runtime fields; save/play/selection-change boundaries restore them.
  snapshotAnimationPreview(engine, entity, COMPONENT);

  engine.set(entity, token, patch);
  return { ok: true };
}

registerApplier('session', 'setAnimationPreview', applySetAnimationPreview as SessionApplier, {
  title: 'Preview Animation Playback',
});
