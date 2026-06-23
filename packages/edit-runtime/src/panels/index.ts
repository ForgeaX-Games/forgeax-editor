// panels/index.ts — edit-runtime panel component barrel (M5 w25/w26).
//
// Each panel exported here is rendered by DetachedPanel when the
// corresponding ep:* iframe loads with ?panel=<id>.

export { SystemsPanel } from './systems-panel';
export type { SystemsPanelProps } from './systems-panel';
export { InspectorWithAddComponent } from './inspector';
export { AddComponentMenu } from './add-component-menu';
export type { AddComponentMenuProps } from './add-component-menu';