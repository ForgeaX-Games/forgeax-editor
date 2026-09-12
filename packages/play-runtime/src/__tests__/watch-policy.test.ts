import { describe, expect, it } from 'bun:test';
import {
  PLAY_RUNTIME_STATIC_WATCH_IGNORES,
  PLAY_VITE_HMR_PATH,
  playViteHmrSocketPath,
} from '../watch-policy';

describe('play-runtime watch policy', () => {
  it('excludes the Chrome WebGPU profile from the Vite source watcher', () => {
    expect(PLAY_RUNTIME_STATIC_WATCH_IGNORES).toContain('**/.forgeax/chrome-webgpu-profile/**');
  });

  it('does not treat host-games remount tsconfig as a Vite config change', () => {
    expect(PLAY_RUNTIME_STATIC_WATCH_IGNORES).toContain('**/host-games/**/tsconfig.json');
    expect(PLAY_RUNTIME_STATIC_WATCH_IGNORES).toContain('**/host-games/**/jsconfig.json');
    expect(PLAY_RUNTIME_STATIC_WATCH_IGNORES).toContain('**/host-games/**/package.json');
  });

  it('ignores native agent plugin configs while preserving authored game source', () => {
    const ignored = (path: string) => PLAY_RUNTIME_STATIC_WATCH_IGNORES.some(pattern => new Bun.Glob(pattern).match(path));
    expect(ignored('/workspace/play/.forgeax/user/codex/session/forge/plugins/cache/template/tsconfig.json')).toBe(true);
    expect(ignored('/workspace/.forgeax/games/bubble/src/main.ts')).toBe(false);
    expect(ignored('/workspace/.forgeax/games/bubble/assets/arena.pack.ts')).toBe(false);
  });

  it('keeps the Play HMR websocket off the preview HTML document path', () => {
    expect(PLAY_VITE_HMR_PATH.startsWith('/')).toBe(false);
    expect(playViteHmrSocketPath()).toBe('/preview/__vite_hmr');
    expect(playViteHmrSocketPath()).not.toBe('/preview/');
    expect(playViteHmrSocketPath()).not.toBe('/preview');
  });
});
