// ScanOverlay.tsx — blocking full-screen overlay during asset scan (G4).
//
// Displays a progress bar + current file name while the scan is running.
// Prevents user interaction with all editor panels (viewport, hierarchy,
// content browser, inspector) except Info Log. Uses CSS z-index + pointer-events
// to enforce the block.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G4

import React, { useState, useEffect, type FC } from 'react';
import { getScanProgress, onScanProgress, type ScanProgressState } from '@forgeax/editor-core';

/** A blocking overlay shown during startup asset scan. */
export const ScanOverlay: FC = () => {
  const [state, setState] = useState<ScanProgressState>(() => getScanProgress());
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const unsub = onScanProgress((s) => {
      setState(s);
      // Show overlay as soon as scanning starts, hide when done
      if (s.phase !== 'idle' && s.phase !== 'done') {
        setVisible(true);
      } else if (s.phase === 'done' || s.phase === 'idle') {
        setVisible(false);
      }
    });

    // Check if already scanning
    const current = getScanProgress();
    if (current.phase !== 'idle' && current.phase !== 'done') {
      setVisible(true);
      setState(current);
    }

    return unsub;
  }, []);

  if (!visible) return null;

  const percent = state.total > 0 ? Math.min(100, Math.round((state.current / state.total) * 100)) : 0;
  const phaseLabel = state.phase === 'scanning' ? 'Scanning Assets...'
    : state.phase === 'generating-meta' ? 'Generating Meta Files...'
    : state.phase === 'importing' ? 'Importing Assets...'
    : 'Processing...';

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      zIndex: 10000,
      backgroundColor: 'rgba(0, 0, 0, 0.65)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'all',
      userSelect: 'none',
    }}>
      <div style={{
        backgroundColor: '#1a1a2e',
        borderRadius: 12,
        padding: '32px 48px',
        minWidth: 380,
        maxWidth: 480,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        color: '#e0e0e0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 20, color: '#fff' }}>
          {phaseLabel}
        </div>

        <div style={{
          height: 6,
          backgroundColor: '#333',
          borderRadius: 3,
          overflow: 'hidden',
          marginBottom: 16,
        }}>
          <div style={{
            height: '100%',
            width: `${percent}%`,
            backgroundColor: '#4fc3f7',
            borderRadius: 3,
            transition: 'width 0.3s ease',
          }} />
        </div>

        <div style={{ fontSize: 13, color: '#aaa', marginBottom: 8 }}>
          {percent}% ({state.current} / {state.total} files)
        </div>

        {state.currentFile && (
          <div style={{
            fontSize: 12,
            color: '#777',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginBottom: 8,
          }}>
            {state.currentFile}
          </div>
        )}

        {state.errors.length > 0 && (
          <div style={{
            fontSize: 12,
            color: '#ff8a65',
            marginTop: 8,
          }}>
            {state.errors.length} warning(s)
          </div>
        )}
      </div>
    </div>
  );
};
