// Standalone single-realm viewport surface. Boots the forgeax engine IN-PROCESS
// in the shell window — the same architecture Studio uses via its EditRealm.
// This lets panels (Inspector, Hierarchy) access the live RuntimeUiGraph directly
// and render LocalInspectorPanel instead of the limited RemoteInspectorPanel.
//
// Compared to Studio's EditRealm, this is simplified:
//   - Single game (no cross-game teardown/remount orchestration)
//   - No carrier transport (no server-driven editor session)
//   - No EditorCanonicalProjection (no AI/server parity projection)
// It retains:
//   - pagehide lifecycle (WebGPU device release)
//   - HMR game-code change → restart play
//   - disk-watch asset refresh → remount viewport

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ViewportComponent, resetEditRealm } from '@forgeax/editor-edit-runtime/viewport/viewport-component';
import { gateway, panelBridge, hasPendingDiskSave } from '@forgeax/editor-core';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';

export interface StandaloneEditRealmProps {
  readonly gameSlug: string | null;
  readonly gameRoot?: string;
  readonly runtimeBinding?: RuntimeAssetBinding;
}

export function StandaloneEditRealm({ gameSlug, gameRoot, runtimeBinding }: StandaloneEditRealmProps): ReactNode {
  const [viewportEpoch, setViewportEpoch] = useState(0);
  const playRestartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Release WebGPU device on page unload (not BFCache restore).
  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent): void => {
      if (event.persisted) return;
      resetEditRealm();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // HMR game-code change → restart play (mirrors Studio EditRealm).
  useEffect(() => {
    if (!gameSlug || !import.meta.hot) return;
    const onGameCodeChange = (data: { file?: string }): void => {
      const file = (data.file ?? '').replace(/\\/g, '/');
      if (!file.includes(`/${gameSlug}/`)) return;
      if (gateway.mode !== 'play') return;
      if (playRestartTimer.current !== null) clearTimeout(playRestartTimer.current);
      playRestartTimer.current = setTimeout(() => {
        playRestartTimer.current = null;
        gateway.dispatch({ kind: 'stop' }, 'human');
        queueMicrotask(() => gateway.dispatch({ kind: 'play' }, 'human'));
      }, 80);
    };
    import.meta.hot.on('forgeax:game-code-change', onGameCodeChange);
    return () => {
      if (playRestartTimer.current !== null) {
        clearTimeout(playRestartTimer.current);
        playRestartTimer.current = null;
      }
      import.meta.hot?.off('forgeax:game-code-change', onGameCodeChange);
    };
  }, [gameSlug]);

  // Disk-watch asset refresh → reset realm + remount viewport.
  // Skip the reset when not playing AND there are unsaved edits (protect user work).
  useEffect(() => {
    if (!gameSlug) return;
    const off = panelBridge.on('assetsChanged', ({ hint, source }) => {
      if (source !== 'disk-watch') return;
      if (hint === 'directory-only') return;
      if (assetRefreshTimer.current !== null) clearTimeout(assetRefreshTimer.current);
      assetRefreshTimer.current = setTimeout(() => {
        assetRefreshTimer.current = null;
        const isPlaying = gateway.mode === 'play' || gateway.playPhase === 'starting';
        if (!isPlaying && hasPendingDiskSave()) return;
        resetEditRealm({ flushPendingSave: false });
        setViewportEpoch((epoch) => epoch + 1);
      }, 120);
    });
    return () => {
      off();
      if (assetRefreshTimer.current !== null) {
        clearTimeout(assetRefreshTimer.current);
        assetRefreshTimer.current = null;
      }
    };
  }, [gameSlug]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#16161a' }}>
      <ViewportComponent
        key={`${gameSlug ?? 'default'}:${viewportEpoch}`}
        gameSlug={gameSlug}
        gameRoot={gameRoot}
        runtimeBinding={runtimeBinding}
      />
    </div>
  );
}
