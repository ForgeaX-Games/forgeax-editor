// Slim entry — only the delete-guard bus + host adapter (no ContentBrowser).
//
// Hosts (standalone/main.tsx, studio host) that need to wire the keyboard
// router's confirm-delete gate at BOOT must not eagerly import the full
// content-browser barrel, because that barrel re-exports ContentBrowser, which
// side-effect imports content-browser.css and pulls in the whole CB module
// graph. Importing this slim entry keeps that footprint out of the initial
// boot chunk; the Assets panel still lazy-imports the full barrel on demand
// (packages/panels/src/Assets.tsx).

export { DeleteGuardDialogHost } from './DeleteGuardDialogHost';
export {
  requestDeleteGuard,
  subscribeDeleteGuard,
  resolveDeleteGuard,
  type DeleteGuardAsset,
  type DeleteGuardRequest,
} from './delete-guard-bus';
