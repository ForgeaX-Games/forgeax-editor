export type GameEntryImporter = (url: string) => Promise<unknown>;

export async function importFirstGameEntry(
  candidates: readonly string[],
  importer: GameEntryImporter,
): Promise<unknown> {
  const failures: Array<{ url: string; error: unknown }> = [];
  for (const url of candidates) {
    try {
      return await importer(url);
    } catch (error) {
      failures.push({ url, error });
    }
  }
  throw new AggregateError(
    failures.map(({ error }) => error),
    `game entry could not be imported; tried ${failures.map(({ url }) => url).join(', ')}`,
  );
}
