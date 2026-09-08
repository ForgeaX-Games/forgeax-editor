// Browser-safe runtime surface for the Engine plugin root entry.
//
// Keep this Vite alias pointed at Engine's browser entry so the standalone
// host gets the same ToolPlugin helpers as the package export without pulling
// the Node-only catalog loader into the browser graph.
export * from '../../packages/engine/packages/plugin/src/browser.ts';
