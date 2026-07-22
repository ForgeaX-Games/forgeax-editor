// ForgeaX editor icon registry — hand-authored 24x24 stroke SVG bodies ported
// verbatim from the forgeax-studio interaction spec (forgeax-studio-demo). Kept
// as inner-SVG markup strings so <ForgeaxIcon> can reproduce the spec pixel for
// pixel (stroke-width 1.7, round caps/joins) instead of approximating with a
// third-party icon set whose paths differ subtly.
//
// currentColor is used throughout so a token-driven `color` flows in. A few
// glyphs (material / dot) intentionally set fill="currentColor" stroke="none"
// on an inner node for a filled look.

export const FORGEAX_ICONS = {
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A11 11 0 0 1 12 5c6.4 0 10 7 10 7a13 13 0 0 1-2.2 2.9"/><path d="M6.5 6.6A13 13 0 0 0 2 12s3.6 7 10 7a10.7 10.7 0 0 0 3.9-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.6-1.8"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11.5v5M9.5 14h5"/>',
  layers: '<path d="M12 3l9 4.5-9 4.5-9-4.5L12 3z"/><path d="M3 12l9 4.5L21 12"/><path d="M3 16.5l9 4.5 9-4.5"/>',
  box: '<path d="M21 7.5l-9-4.5-9 4.5 9 4.5 9-4.5z"/><path d="M3 7.5v9l9 4.5 9-4.5v-9"/><path d="M12 12v9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  video: '<path d="M3 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M15 10l6-3.5v11L15 14"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-1.5 3.5L16 11H5"/>',
  hexagon: '<path d="M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h7M15 17h5"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="13" cy="17" r="2"/>',
  cursor: '<path d="M5 3l7 17 2.4-6.6L21 11z"/>',
  move: '<path d="M12 2v20M2 12h20"/><path d="M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  scale: '<path d="M15 3h6v6M21 3l-7 7"/><path d="M9 21H3v-6M3 21l7-7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3.6 3 14.4 0 18M12 3c-3 3.6-3 14.4 0 18"/>',
  magnet: '<path d="M6 4h4v7a2 2 0 0 0 4 0V4h4v7a6 6 0 0 1-12 0z"/><path d="M6 8h4M14 8h4"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  edit: '<path d="M4 20h4L18.5 9.5l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-2"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H9a5 5 0 0 0 0 10h2"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 3v5h7"/><path d="M8 21v-6h8v6"/>',
  barChart: '<path d="M4 20V12M10 20V6M16 20v-9"/><path d="M3 20h18"/>',
  layoutGrid: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M3 12h18"/>',
  laySingle: '<rect x="3" y="4" width="18" height="16" rx="2"/>',
  layCols: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  layRows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  layTri: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M13 4v16M13 12h8"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  star: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.1 1.2 6L12 16.9 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  expand: '<path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/>',
  collapse: '<path d="M9 4v4a1 1 0 0 1-1 1H4M15 4v4a1 1 0 0 0 1 1h4M9 20v-4a1 1 0 0 0-1-1H4M15 20v-4a1 1 0 0 1 1-1h4"/>',
  axis3d: '<path d="M12 21V9M12 9L5 5M12 9l7-4M12 21l-7-4M12 21l7-4"/>',
  move3d: '<path d="M12 3v9M12 12L4 8M12 12l8-4M4 8v8l8 4 8-4V8"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  link: '<path d="M9.5 14.5l5-5"/><path d="M10.5 6l1.2-1.2a4 4 0 0 1 5.7 5.7L16 12"/><path d="M13.5 18l-1.2 1.2a4 4 0 0 1-5.7-5.7L8 12"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  material: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/>',
  floor: '<path d="M12 3v11M8 10l4 4 4-4M4 20h16"/>',
  focus: '<path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3"/><circle cx="12" cy="12" r="2.5"/>',
  dot: '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/>',
} as const;

export type ForgeaxIconName = keyof typeof FORGEAX_ICONS;
