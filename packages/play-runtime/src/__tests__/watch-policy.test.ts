import { describe, expect, it } from 'bun:test';
import { PLAY_RUNTIME_STATIC_WATCH_IGNORES } from '../watch-policy';

describe('play-runtime watch policy', () => {
  it('excludes the Chrome WebGPU profile from the Vite source watcher', () => {
    expect(PLAY_RUNTIME_STATIC_WATCH_IGNORES).toContain('**/.forgeax/chrome-webgpu-profile/**');
  });
});
