/** Game-relative path for the virtual UE-style "All" root (project top level). */
export const VIRTUAL_ROOT_PATH = '';

export function isVirtualRootPath(path: string): boolean {
  return path === VIRTUAL_ROOT_PATH;
}
