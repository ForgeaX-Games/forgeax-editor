// AnimationTransportBar — the bespoke Inspector preview transport (M1).
//
// Renders against a REAL world bound to the singleton gateway (no module
// mocking — same pattern as AssetPicker.test): an entity carrying
// AnimationPlayer with a clip whose payload duration resolves through
// gateway.resolveAsset. Pins: enabled controls + live phase from times[0] /
// duration, the no-clip disabled state, and null render when the component
// declares no playback transport.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { World } from '@forgeax/engine-ecs';
import { AnimationPlayer } from '@forgeax/engine-animation';
import { Name } from '@forgeax/engine-scene';
import { gateway } from '@forgeax/editor-core';

import AnimationTransportBar from '../AnimationTransportBar';

void AnimationPlayer;

const world = new World();
const clip = world.allocSharedRef('AnimationClip', { kind: 'animation-clip', duration: 4 });
// Every fixture entity carries Name — entComponent's liveness probe
// (world.get(handle, Name)) treats a Name-less handle as stale.
const withClip = world.spawn(
  { component: Name, data: { value: 'withClip' } },
  {
    component: AnimationPlayer,
    data: {
      clips: [clip],
      times: [2],
      weights: [1],
      speeds: [1],
      paused: true,
    },
  },
);
const noClip = world.spawn(
  { component: Name, data: { value: 'noClip' } },
  { component: AnimationPlayer, data: {} },
);
if (!withClip.ok || !noClip.ok) throw new Error('spawn failed in test setup');

const doc = gateway.doc as { world: unknown };
const origWorld = doc.world;

beforeAll(() => {
  doc.world = world;
});

afterAll(() => {
  doc.world = origWorld;
});

describe('AnimationTransportBar', () => {
  it('renders enabled transport controls with the live phase for a bound clip', () => {
    const html = renderToStaticMarkup(
      <AnimationTransportBar entity={withClip.value} component="AnimationPlayer" />,
    );
    expect(html).toContain('anim-transport-AnimationPlayer');
    expect(html).toContain('anim-play-toggle');
    expect(html).toContain('anim-phase');
    expect(html).toContain('anim-speed');
    // times[0]=2s / duration=4s → phase 0.5 reflected on the range input.
    expect(html).toContain('value="0.5"');
    // Bound clip → controls enabled, no empty-hint.
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('anim-no-clip');
  });

  it('disables the transport and shows the hint when no clip is bound', () => {
    const html = renderToStaticMarkup(
      <AnimationTransportBar entity={noClip.value} component="AnimationPlayer" />,
    );
    expect(html).toContain('anim-no-clip');
    expect(html).toContain('disabled=""');
  });

  it('renders null for a component without a playback transport contract', () => {
    const html = renderToStaticMarkup(
      <AnimationTransportBar entity={withClip.value} component="Transform" />,
    );
    expect(html).toBe('');
  });
});
