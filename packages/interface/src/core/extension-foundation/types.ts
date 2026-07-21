// Thin re-export shell — implementation lives in
// @forgeax-studio/extension-platform (ADR 0026). Kept so existing
// `core/extension-foundation/*` import paths stay valid.
export type {
  BusEvent,
  Cleanup,
  EventMap,
  ExtensionManifest,
  Listener,
  ListenerErrorHandler,
  Middleware,
  SetupReturn,
} from '@forgeax-studio/extension-platform';
