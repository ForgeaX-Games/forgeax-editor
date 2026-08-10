// bespoke-editors — the bespoke Inspector editor registry (animation-preview M1).
//
// A component's reflected meta contract may declare `bespoke.editorId`
// (editor overlay meta.editor.bespoke interim; engine meta long-term). The
// Inspector resolves the id through THIS registry: a registered editor renders
// above the component's generic fields; an unregistered id falls back to the
// historical hint line, so a missing panel never breaks the Inspector.

import type { ComponentType } from 'react';
import type { EntityHandle } from '@forgeax/editor-core';
import AnimationTransportBar from './AnimationTransportBar';
import SocketCalibrationBar from './SocketCalibrationBar';
import FacingCorrectionBar from './FacingCorrectionBar';

export interface BespokeEditorProps {
  /** The inspected entity handle (active edit world). */
  entity: EntityHandle;
  /** The component name the bespoke editor drives. */
  component: string;
}

const _registry = new Map<string, ComponentType<BespokeEditorProps>>();

export function registerBespokeEditor(editorId: string, editor: ComponentType<BespokeEditorProps>): void {
  _registry.set(editorId, editor);
}

export function getBespokeEditor(editorId: string): ComponentType<BespokeEditorProps> | undefined {
  return _registry.get(editorId);
}

// ── Builtin editors ─────────────────────────────────────────────────────────
registerBespokeEditor('animation-transport', AnimationTransportBar);
registerBespokeEditor('socket-calibration', SocketCalibrationBar);
registerBespokeEditor('facing-correction', FacingCorrectionBar);
