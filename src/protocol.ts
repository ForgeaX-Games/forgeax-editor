// @forgeax/editor/protocol — pass-through to editor-core SSOT.
//
// All 16 VAG_* schemas + sendVagMessage + VagMessageError + PayloadOf
// live at `@forgeax/editor-core/protocol`. This file is a zero-logic
// re-export so that existing consumers of `@forgeax/editor/protocol`
// resolve transparently through the sub-path.
//
// Anchors:
//   requirements §5 AC-14 (16 schemas re-exported, consumer 0 change)
//   plan-strategy §2 D-3 (sub-path pass-through)
export * from '@forgeax/editor-core/protocol';