// @forgeax/editor/protocol — VAG_* postMessage schema SSOT.
//
// 16 zod schemas covering every VAG_* message type observed in the
// editor / preview wire (research F-6 grep evidence). Naming is
// strictly paired:
//
//   Vag<Name>Schema  — runtime z.object validator (consumer side)
//   Vag<Name>Message — TypeScript type derived via z.infer<typeof ...>
//
// Two shape families exist in the wire:
//   1. payload-wrapped:  { type, payload: { ... } }
//      ASSETS_CHANGED, CONSOLE, EDITOR_OPEN_SOURCE, EDITOR_POPOUT,
//      EDITOR_REDOCK, EDITOR_REF, FPS_STATS, SPAWN_ENTITY
//   2. type-only / flat: { type } or { type, ...fields }
//      DEVICE_LOST, EDITOR_FLUSH, PREVIEW_DISPOSE, PREVIEW_PAUSE,
//      PREVIEW_PLAY, PREVIEW_RELOAD (type-only)
//      CONTEXT_MENU, CONTEXT_MENU_ACTION (flat extra fields)
//
// Schema contracts intentionally mirror the actual on-wire shape from
// the producer call sites (see anchors per schema). Fields not present
// on the wire today are NOT added speculatively (plan-strategy §2 D-4
// "no try-catch silent swallow" — schemas surface real divergence).
//
// Anchors:
//   requirements §AC-03 (16 schemas)
//   requirements §AC-05 (safeParse error.issues structured failure)
//   plan-strategy §2 D-3 (single physical location)
//   plan-strategy §2 D-4 (no silent type assertion)
//   plan-strategy §8.1 (Vag<Name>Schema + Vag<Name>Message naming pair)
//   research F-6 (16 type literals enumerated by grep)

import { z } from 'zod';

// ── 1. VAG_ASSETS_CHANGED ────────────────────────────────────────────────────
// Producer: EditMode.tsx:186 / 230 (interface, slug-bearing) and
// editor-runtime/store.ts (BroadcastChannel relay, payload-less ping).
// Two real shapes coexist on the wire today: a with-payload form carrying
// the slug whose pack changed, and a payload-less ping used by the relay
// path inside editor-runtime where no slug context is available.
// `payload` is therefore optional and `payload.slug` likewise — the
// schema accepts both shapes. Consumers that need the slug should narrow
// after safeParse.
export const VagAssetsChangedSchema = z.object({
  type: z.literal('VAG_ASSETS_CHANGED'),
  payload: z
    .object({
      slug: z.string().optional(),
    })
    .optional(),
});
export type VagAssetsChangedMessage = z.infer<typeof VagAssetsChangedSchema>;

// ── 2. VAG_CONSOLE ───────────────────────────────────────────────────────────
// Producer: editor-runtime/main.tsx:267,272,275 (console proxy + global error).
// Carries a single console line + level + ts. Consumer pushes to the in-UI
// Console panel.
export const VagConsoleSchema = z.object({
  type: z.literal('VAG_CONSOLE'),
  payload: z.object({
    level: z.enum(['log', 'warn', 'error', 'info', 'debug']),
    text: z.string(),
    ts: z.number(),
  }),
});
export type VagConsoleMessage = z.infer<typeof VagConsoleSchema>;

// ── 3. VAG_CONTEXT_MENU ──────────────────────────────────────────────────────
// Producer: editor-runtime/ui/contextMenuService.tsx:57.
// Flat shape — no payload wrapper. menuId pairs the open with the action.
// items[] are wire-shaped menu rows (separator OR id+label+disabled+danger).
export const VagContextMenuSchema = z.object({
  type: z.literal('VAG_CONTEXT_MENU'),
  menuId: z.string(),
  x: z.number(),
  y: z.number(),
  items: z.array(
    z.union([
      z.object({ sep: z.literal(true) }),
      z.object({
        id: z.string(),
        label: z.string().optional(),
        disabled: z.boolean().optional(),
        danger: z.boolean().optional(),
      }),
    ]),
  ),
});
export type VagContextMenuMessage = z.infer<typeof VagContextMenuSchema>;

// ── 4. VAG_CONTEXT_MENU_ACTION ───────────────────────────────────────────────
// Producer: interface/components/ContextMenu/ContextMenu.tsx:72.
// Flat shape (no payload wrapper). Pairs back to the open via menuId, picks
// the chosen row via actionId.
export const VagContextMenuActionSchema = z.object({
  type: z.literal('VAG_CONTEXT_MENU_ACTION'),
  menuId: z.string(),
  actionId: z.string(),
});
export type VagContextMenuActionMessage = z.infer<typeof VagContextMenuActionSchema>;

// ── 5. VAG_DEVICE_LOST ───────────────────────────────────────────────────────
// Producer: engine surface (loss event broadcast); see PreviewMode.tsx:151.
// Type-only ping — interface reacts by reloading the iframe.
export const VagDeviceLostSchema = z.object({
  type: z.literal('VAG_DEVICE_LOST'),
});
export type VagDeviceLostMessage = z.infer<typeof VagDeviceLostSchema>;

// ── 6. VAG_EDITOR_FLUSH ──────────────────────────────────────────────────────
// Producer: EditMode.tsx:135 (interface). Type-only command asking the editor
// runtime to flush any pending save-debounce before unmount.
export const VagEditorFlushSchema = z.object({
  type: z.literal('VAG_EDITOR_FLUSH'),
});
export type VagEditorFlushMessage = z.infer<typeof VagEditorFlushSchema>;

// ── 7. VAG_EDITOR_OPEN_SOURCE ────────────────────────────────────────────────
// Producer: editor-runtime/dock.ts:17. Tells interface to switch to the
// authoring plugin (workbench tab) for the entity's source provenance.
// docId is best-effort target within the plugin (optional).
export const VagEditorOpenSourceSchema = z.object({
  type: z.literal('VAG_EDITOR_OPEN_SOURCE'),
  payload: z.object({
    plugin: z.string(),
    docId: z.string().optional(),
  }),
});
export type VagEditorOpenSourceMessage = z.infer<typeof VagEditorOpenSourceSchema>;

// ── 8. VAG_EDITOR_POPOUT ─────────────────────────────────────────────────────
// Producer: editor-runtime/panels/Dock.tsx:151. Asks interface to spawn a
// labeled OS-window (Tauri WebviewWindow / window.open) carrying that panel.
// scene defaults to 'default'; geom optionally restores remembered geometry.
export const VagEditorPopoutSchema = z.object({
  type: z.literal('VAG_EDITOR_POPOUT'),
  payload: z.object({
    panel: z.string(),
    scene: z.string().optional(),
    title: z.string().optional(),
    geom: z
      .object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
      })
      .nullable()
      .optional(),
  }),
});
export type VagEditorPopoutMessage = z.infer<typeof VagEditorPopoutSchema>;

// ── 9. VAG_EDITOR_REDOCK ─────────────────────────────────────────────────────
// Producer: editor-runtime/panels/Dock.tsx:160. Asks interface to close the
// labeled popout window for the panel.
export const VagEditorRedockSchema = z.object({
  type: z.literal('VAG_EDITOR_REDOCK'),
  payload: z.object({
    panel: z.string(),
  }),
});
export type VagEditorRedockMessage = z.infer<typeof VagEditorRedockSchema>;

// ── 10. VAG_EDITOR_REF ───────────────────────────────────────────────────────
// Producer: editor-runtime/store.ts:250 / 262 / 274 — three kinds:
//   kind='entity'    — id + name + components[] (+ source?)
//   kind='component' — entityId + entityName + comp + value
//   kind='asset'     — guid + assetKind + name (+ packPath?)
// Schema accepts a discriminated union by kind so consumers (EditMode.tsx
// composer) can narrow without a chain of `as` casts.
export const VagEditorRefSchema = z.object({
  type: z.literal('VAG_EDITOR_REF'),
  payload: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('entity'),
      id: z.union([z.number(), z.string()]),
      name: z.string(),
      components: z.array(z.string()).optional(),
      source: z
        .object({
          plugin: z.string().optional(),
          docId: z.string().optional(),
        })
        .optional(),
    }),
    z.object({
      kind: z.literal('component'),
      entityId: z.number(),
      entityName: z.string(),
      comp: z.string(),
      value: z.unknown().optional(),
    }),
    z.object({
      kind: z.literal('asset'),
      guid: z.string(),
      assetKind: z.string(),
      name: z.string(),
      packPath: z.string().optional(),
    }),
  ]),
});
export type VagEditorRefMessage = z.infer<typeof VagEditorRefSchema>;

// ── 11. VAG_FPS_STATS ────────────────────────────────────────────────────────
// Producer: editor-runtime/main.tsx:254. Carries a per-second fps integer.
// Consumer: EditMode.tsx:245, PreviewMode.tsx:146.
export const VagFpsStatsSchema = z.object({
  type: z.literal('VAG_FPS_STATS'),
  payload: z.object({
    fps: z.number(),
  }),
});
export type VagFpsStatsMessage = z.infer<typeof VagFpsStatsSchema>;

// ── 12. VAG_PREVIEW_DISPOSE ──────────────────────────────────────────────────
// Producer: PreviewMode.tsx:287 / 324 / 414 (interface). Type-only command
// asking the preview iframe to dispose its engine before src reset / unmount.
export const VagPreviewDisposeSchema = z.object({
  type: z.literal('VAG_PREVIEW_DISPOSE'),
});
export type VagPreviewDisposeMessage = z.infer<typeof VagPreviewDisposeSchema>;

// ── 13. VAG_PREVIEW_PAUSE ────────────────────────────────────────────────────
// Producer: PreviewMode.tsx:407 (sendToGame helper). Type-only.
export const VagPreviewPauseSchema = z.object({
  type: z.literal('VAG_PREVIEW_PAUSE'),
});
export type VagPreviewPauseMessage = z.infer<typeof VagPreviewPauseSchema>;

// ── 14. VAG_PREVIEW_PLAY ─────────────────────────────────────────────────────
// Producer: PreviewMode.tsx:407 (sendToGame helper). Type-only.
export const VagPreviewPlaySchema = z.object({
  type: z.literal('VAG_PREVIEW_PLAY'),
});
export type VagPreviewPlayMessage = z.infer<typeof VagPreviewPlaySchema>;

// ── 15. VAG_PREVIEW_RELOAD ───────────────────────────────────────────────────
// Producer: interface preview / engine HMR path. Type-only — receiver does
// location.reload() (editor-runtime/main.tsx:326).
export const VagPreviewReloadSchema = z.object({
  type: z.literal('VAG_PREVIEW_RELOAD'),
});
export type VagPreviewReloadMessage = z.infer<typeof VagPreviewReloadSchema>;

// ── 16. VAG_SPAWN_ENTITY ─────────────────────────────────────────────────────
// Producer: EditMode.tsx:226 (after import-scene). Two modes:
//   mode='reference' — payload.entity carries a single ECS spawn cmd seed
//   mode='full'      — payload.doc carries an entire SceneDocument tree
// entity / doc / name are kept loosely shaped (z.unknown / z.string?) since
// the engine-side ECS schemas evolve independently — this schema asserts
// the message envelope, not the engine doc structure.
export const VagSpawnEntitySchema = z.object({
  type: z.literal('VAG_SPAWN_ENTITY'),
  payload: z.object({
    mode: z.enum(['reference', 'full']),
    entity: z.unknown().optional(),
    doc: z.unknown().optional(),
    name: z.string().optional(),
  }),
});
export type VagSpawnEntityMessage = z.infer<typeof VagSpawnEntitySchema>;
