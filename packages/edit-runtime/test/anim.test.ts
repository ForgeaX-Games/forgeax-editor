import { test, expect } from 'bun:test';
import {
  sampleTrack, sampleClip, upsertKey, removeKeyAt, smoothstep,
  clipDuration, trackEnd, setKey, removeKey, findTrack, emptyClip,
  type Keyframe, type Clip,
} from '../src/core/anim';

const K = (t: number, v: number, interp?: 'linear' | 'step' | 'smooth'): Keyframe => (interp ? { t, v, interp } : { t, v });

test('sampleTrack: empty → undefined; holds ends', () => {
  expect(sampleTrack([], 1)).toBeUndefined();
  const ks = [K(1, 10), K(3, 30)];
  expect(sampleTrack(ks, 0)).toBe(10); // before start holds first
  expect(sampleTrack(ks, 5)).toBe(30); // after end holds last
  expect(sampleTrack(ks, 1)).toBe(10);
  expect(sampleTrack(ks, 3)).toBe(30);
});

test('sampleTrack: linear interpolation at the midpoint', () => {
  expect(sampleTrack([K(0, 0), K(2, 10)], 1)).toBeCloseTo(5, 6);
  expect(sampleTrack([K(0, 0), K(4, 8)], 3)).toBeCloseTo(6, 6);
});

test('sampleTrack: step holds the left value across the segment', () => {
  const ks = [K(0, 0, 'step'), K(2, 10)];
  expect(sampleTrack(ks, 0.1)).toBe(0);
  expect(sampleTrack(ks, 1.99)).toBe(0);
  expect(sampleTrack(ks, 2)).toBe(10);
});

test('sampleTrack: smooth uses smoothstep easing', () => {
  const ks = [K(0, 0, 'smooth'), K(1, 10)];
  expect(sampleTrack(ks, 0.5)).toBeCloseTo(5, 6); // smoothstep(0.5)=0.5
  expect(sampleTrack(ks, 0.25)).toBeCloseTo(smoothstep(0.25) * 10, 6);
  expect(sampleTrack(ks, 0.25)).toBeLessThan(2.5); // eased slower than linear at the start
});

test('sampleTrack: binary search picks the right segment with many keys', () => {
  const ks = [K(0, 0), K(1, 10), K(2, 20), K(3, 30), K(4, 40)];
  expect(sampleTrack(ks, 2.5)).toBeCloseTo(25, 6);
  expect(sampleTrack(ks, 3.5)).toBeCloseTo(35, 6);
});

test('upsertKey: inserts sorted and replaces a key at the same time', () => {
  let ks = upsertKey([], K(2, 20));
  ks = upsertKey(ks, K(0, 0));
  ks = upsertKey(ks, K(1, 10));
  expect(ks.map((k) => k.t)).toEqual([0, 1, 2]);
  ks = upsertKey(ks, K(1, 99)); // replace at t=1
  expect(ks.length).toBe(3);
  expect(sampleTrack(ks, 1)).toBe(99);
});

test('removeKeyAt removes the matching key', () => {
  const ks = [K(0, 0), K(1, 10), K(2, 20)];
  expect(removeKeyAt(ks, 1).map((k) => k.t)).toEqual([0, 2]);
  expect(removeKeyAt(ks, 9).length).toBe(3); // no match → unchanged
});

test('clip ops: setKey creates tracks, grows duration, sampleClip flattens', () => {
  let clip: Clip = emptyClip(1);
  clip = setKey(clip, 'Transform.x', K(0, 0));
  clip = setKey(clip, 'Transform.x', K(2, 10));
  clip = setKey(clip, 'Transform.y', K(0, 5));
  expect(findTrack(clip, 'Transform.x')!.keys.length).toBe(2);
  expect(clipDuration(clip)).toBe(2);
  expect(clip.duration).toBe(2); // grown from 1
  expect(sampleClip(clip, 1)).toEqual({ 'Transform.x': 5, 'Transform.y': 5 });
});

test('clip ops: removeKey drops an emptied track', () => {
  let clip: Clip = emptyClip();
  clip = setKey(clip, 'Transform.x', K(0, 0));
  clip = removeKey(clip, 'Transform.x', 0);
  expect(findTrack(clip, 'Transform.x')).toBeNull();
  expect(clip.tracks.length).toBe(0);
});

test('trackEnd reports the last key time', () => {
  expect(trackEnd({ channel: 'c', keys: [] })).toBe(0);
  expect(trackEnd({ channel: 'c', keys: [K(0, 0), K(3.5, 1)] })).toBe(3.5);
});
