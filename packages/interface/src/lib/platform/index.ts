/**
 * Platform layer — the single seam between the platform-agnostic React app and
 * the host it runs in (Tauri desktop shell vs plain browser / web-server form).
 *
 * Import from here, never reach into '@tauri-apps/*' directly from components.
 */
export {
  isTauri,
  platformRuntime,
  type PlatformRuntime,
} from './runtime';
export { getShellAdapter, type ShellAdapter } from './shell-adapter';
export {
  getWindowManager,
  type WindowManager,
  type DetachWindowOptions,
} from './window-manager';
export {
  type SurfaceDescriptor,
  type SurfaceKind,
  type SurfacePane,
  surfaceKey,
  surfaceWindowLabel,
  encodeSurfaceQuery,
  decodeSurfaceFromLocation,
} from './surface';
