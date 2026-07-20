// store/frame-request — STUB (applier migrated to edit-runtime).
//
// The requestFrame session op ("center the viewport on the primary selection")
// is now registered by edit-runtime's createViewport() via registerSessionApplier
// — same pattern as cameraOrbit / play / stop (D-11). The applier needs the
// viewport closure (orbit target, dist, applyCamera) which only exists at
// runtime, so it cannot live in headless core.
//
// In headless core (tests without edit-runtime boot), dispatching requestFrame
// returns UNKNOWN_OP — identical to play/stop (D-11 precedent).
//
// History:
//   D-10 (loop 1): requestFrame collected as session op; onFrameRequest deleted
//   D-12 (loop 2): cameraOrbit registered in edit-runtime (same pattern)
//   This migration: applier moved from core → edit-runtime (viewport closure)
