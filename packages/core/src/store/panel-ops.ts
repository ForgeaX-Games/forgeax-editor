// store/panel-ops — session-domain ops for cross-boundary panel coordination.
//
// focusPanel and openSource are session ops: they change editor session state
// (which panel is focused / which source is open), should be visible in the
// ledger (AI can see "human focused Mesh panel"), and are AI-dispatchable.
//
// The applier emits a notification on panelBridge so the interface package
// (which cannot import editor-core) can react via the compat bridge.
//
// North Star §6: session domain — no inverse, ledger only.
import type { EditorOp } from '../types';
import { sessionAppliers } from '../io/appliers';
import { panelBridge } from '../io/panel-bridge';

// ── focusPanel ──────────────────────────────────────────────────────────────

let lastFocusedPanel: string | null = null;
export function getLastFocusedPanel(): string | null { return lastFocusedPanel; }

function applyFocusPanel(op: EditorOp): { ok: true } {
  const { panel } = op as { panel: string };
  lastFocusedPanel = panel;
  panelBridge.emit('focusPanel', { panel });
  return { ok: true };
}
sessionAppliers.set('focusPanel', applyFocusPanel);

// ── openSource ──────────────────────────────────────────────────────────────

function applyOpenSource(op: EditorOp): { ok: true } {
  const { plugin, docId } = op as { plugin: string; docId: string };
  panelBridge.emit('openSource', { plugin, docId });
  return { ok: true };
}
sessionAppliers.set('openSource', applyOpenSource);
