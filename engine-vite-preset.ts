// Config-time facade for the shared Vite engine preset.
//
// Host Vite configs import this entry while esbuild bundles their config. Keep
// the implementation under scripts/vite, where its Node-only producer graph
// belongs, while preserving one stable editor-owned entry for embedded hosts.
export * from './scripts/vite/engine-vite-preset';
