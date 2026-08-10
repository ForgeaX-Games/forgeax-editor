#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACK_PATH = 'games/sample/assets/scene.pack.json';
const EFFECT_PACK_PATH = 'games/sample/assets/vfx/particle-effects.pack.json';
const EFFECT_GUID = '019f56f2-0ac0-776a-9d28-50eb5a9edeb9';
const PLAYER_NAME = 'Arc Nova Skill · Select and Replay';
const FLOW_EMITTER_ID = 'charge-textured-arcane-dial';
const FLOW_MATERIAL_GUID = '427e8932-3ea3-49ad-a8ce-8c9561e53062';
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function parseRef(args) {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === '--ref' && args[1].length > 0) return args[1];
  throw new Error('usage: bun scripts/lint-sample-vfx-skill.mjs [--ref <git-ref>]');
}

function readRepoFile(path, ref) {
  if (ref === undefined) return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  return execFileSync('git', ['-C', repoRoot, 'show', `${ref}:${path}`], { encoding: 'utf8' });
}

function fail(message) {
  throw new Error(`[sample-vfx-skill] ${message}`);
}

function assertValue(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

const ref = parseRef(process.argv.slice(2));
const pack = JSON.parse(readRepoFile(PACK_PATH, ref));
const scene = pack.assets?.find((asset) => asset.kind === 'scene');
if (scene === undefined) fail('scene asset is missing from the sample pack');

const governedPlayers = (scene.payload?.entities ?? []).filter((entity) =>
  entity.components?.Name?.value === PLAYER_NAME &&
  entity.components?.ParticleEffectPlayer !== undefined,
);
if (governedPlayers.length !== 1) {
  fail(`expected exactly one governed replay target, received ${governedPlayers.length}`);
}

const entity = governedPlayers[0];
assertValue(entity.components?.Name?.value, PLAYER_NAME, 'Name.value');
assertValue(entity.components?.Transform?.pos, [0, 1.2, 0], 'Transform.pos');
assertValue(entity.components?.Transform?.scale, [1, 1, 1], 'Transform.scale');
assertValue(entity.components?.ParticleEffectPlayer?.playing, true, 'ParticleEffectPlayer.playing');
assertValue(entity.components?.ParticleEffectPlayer?.seed, 424242, 'ParticleEffectPlayer.seed');
assertValue(entity.components?.ParticleEffectPlayer?.timeScale, 1, 'ParticleEffectPlayer.timeScale');
if (!scene.refs?.includes(EFFECT_GUID)) fail(`scene refs closure is missing ${EFFECT_GUID}`);

const effectPack = JSON.parse(readRepoFile(EFFECT_PACK_PATH, ref));
const effect = effectPack.assets?.find((asset) => asset.guid === EFFECT_GUID);
if (effect === undefined) fail(`particle effect ${EFFECT_GUID} is missing`);
const emitters = effect.payload?.emitters ?? [];
assertValue(emitters.length, 8, 'Arc Nova emitter count');
if (!emitters.every((emitter) => emitter.schedule?.loopDuration === 2.4)) {
  fail('every Arc Nova emitter must share the 2.4 second review loop');
}
if (!emitters.every((emitter) => emitter.backend?.required === 'gpu')) {
  fail('every Arc Nova emitter must remain explicitly GPU-required');
}
assertValue(
  emitters.reduce((total, emitter) => total + (emitter.capacity ?? 0), 0),
  58,
  'Arc Nova total capacity',
);
assertValue(
  emitters.flatMap((emitter) => emitter.schedule?.bursts ?? []).reduce(
    (total, burst) => total + (burst.count ?? 0),
    0,
  ),
  20,
  'Arc Nova purposeful burst count',
);
const flowEmitter = emitters.find((emitter) => emitter.id === FLOW_EMITTER_ID);
if (flowEmitter === undefined) fail(`textured flow emitter ${FLOW_EMITTER_ID} is missing`);
assertValue(flowEmitter.capacity, 2, 'textured flow emitter capacity');
assertValue(flowEmitter.renderers?.length, 1, 'textured flow renderer count');
assertValue(flowEmitter.renderers?.[0]?.kind, 'billboard', 'textured flow renderer kind');
assertValue(
  flowEmitter.renderers?.[0]?.material,
  FLOW_MATERIAL_GUID,
  'textured flow material GUID',
);

console.log(
  `[sample-vfx-skill] PASS (${ref ?? 'worktree'}; one named replay target; 8 GPU emitters; 20 bursts; textured CFX dial)`,
);
