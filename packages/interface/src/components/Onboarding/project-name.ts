/** Turn a free-typed project name into a game slug (GAME_SLUG_RE: lowercase
 *  ascii/digits/hyphens, 1-41). Underscores are NOT allowed for game slugs. */
export function toGameSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Session layout may create `.forgeax/games/default/` (sessions only, no
 * forge.json) before the user has any real project. Never offer that sentinel
 * in onboarding's "已有项目" list — an empty workspace should hide the section.
 */
export function isUserExistingGame(slug: string): boolean {
  return slug !== 'default';
}

/**
 * If the user typed a usable name (slug ≥1 after normalize), keep it.
 * Otherwise allocate `untitled-1`, `untitled-2`, … skipping taken slugs.
 */
export function resolveProjectName(
  rawName: string,
  existingSlugs: Iterable<string> = [],
): { name: string; slug: string } {
  const slug = toGameSlug(rawName);
  if (slug.length >= 1) {
    return { name: rawName.trim() || slug, slug };
  }
  const taken = new Set(existingSlugs);
  let n = 1;
  while (taken.has(`untitled-${n}`)) n += 1;
  const auto = `untitled-${n}`;
  return { name: auto, slug: auto };
}
