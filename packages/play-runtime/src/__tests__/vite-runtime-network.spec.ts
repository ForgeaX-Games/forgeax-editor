import { describe, expect, test } from 'bun:test';
import { assetCorsOrigins, hmrClientPort, playViteHmrOptions } from '../../vite.config';
import { PLAY_VITE_HMR_PATH } from '../watch-policy';

describe('play-runtime Vite network projection', () => {
  test('keeps every loopback origin and uses the isolated interface port by default', () => {
    const env = { FORGEAX_INTERFACE_PORT: '28920' };

    expect(assetCorsOrigins(env)).toEqual([
      'http://127.0.0.1:28920',
      'http://localhost:28920',
      'https://127.0.0.1:28920',
      'https://localhost:28920',
    ]);
    expect(hmrClientPort(env)).toBe(28920);
    expect(playViteHmrOptions(env)).toEqual({
      clientPort: 28920,
      path: PLAY_VITE_HMR_PATH,
    });
  });

  test('honours the derived CORS set and an explicit reverse-proxy HMR port', () => {
    const env = {
      FORGEAX_INTERFACE_PORT: '28920',
      FORGEAX_HMR_CLIENT_PORT: '443',
      FORGEAX_ASSET_CORS_ORIGINS: [
        'https://studio.slot-one.test',
        'http://localhost:28920',
        'http://127.0.0.1:28920',
        'https://localhost:28920',
        'https://127.0.0.1:28920',
      ].join(','),
    };

    expect(assetCorsOrigins(env)).toEqual(env.FORGEAX_ASSET_CORS_ORIGINS.split(','));
    expect(hmrClientPort(env)).toBe(443);
    expect(playViteHmrOptions(env)).toEqual({
      clientPort: 443,
      path: PLAY_VITE_HMR_PATH,
    });
  });
});
