// Single source of truth for project/path/branch shown in the TopBar title.
// Static for now — same constants pattern as `lib/model.ts`. Future iter will
// swap this for a server-side fetch (`/api/health` could return workspace
// metadata) so the title reflects the actual git branch + active game path.
export const CURRENT_PROJECT = {
  name: 'forgeax',
  path: 'games/gta-2.5d',
  branch: 'main',
} as const;
