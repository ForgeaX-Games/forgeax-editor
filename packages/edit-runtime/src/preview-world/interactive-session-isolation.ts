export type InteractivePreviewDomain = 'material' | 'mesh' | 'vfx' | 'texture';
export interface InteractivePreviewSession { readonly source: 'editor-interactive'; readonly domain: InteractivePreviewDomain; readonly subjectGuid: string; readonly sessionId: string; readonly worldId: string; readonly rendererId: string; readonly canvasId: string; }
export interface PreviewSessionLiveIdentity { readonly source: 'engine-tool-run' | 'editor-interactive'; readonly sessionId: string; readonly worldId: string; readonly rendererId: string; readonly canvasId: string; }
export function createInteractivePreviewSession(input: { readonly domain: InteractivePreviewDomain; readonly subjectGuid: string; readonly sessionId: string; readonly worldId?: string; readonly rendererId?: string; readonly canvasId?: string }): InteractivePreviewSession {
  if (input.subjectGuid.length === 0 || input.sessionId.length === 0) throw new Error('interactive preview session requires subject and session identity');
  return Object.freeze({ source: 'editor-interactive' as const, domain: input.domain, subjectGuid: input.subjectGuid, sessionId: input.sessionId, worldId: input.worldId ?? `world:${input.sessionId}`, rendererId: input.rendererId ?? `renderer:${input.sessionId}`, canvasId: input.canvasId ?? `canvas:${input.sessionId}` });
}
export function assertPreviewSessionIsolation(canonical: PreviewSessionLiveIdentity, interactive: PreviewSessionLiveIdentity): { readonly ok: true } | { readonly ok: false; readonly code: 'preview-session-shared-live-state' } {
  if (canonical.source === interactive.source || canonical.sessionId === interactive.sessionId || canonical.worldId === interactive.worldId || canonical.rendererId === interactive.rendererId || canonical.canvasId === interactive.canvasId) return { ok: false, code: 'preview-session-shared-live-state' };
  return { ok: true };
}
