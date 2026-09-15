/** Read host-owned scope before any fallible binding work. Standalone previews
 * without a runtime identity do not participate in managed failure feedback. */
export async function resolveCarrierScope(
  runtimeId: string | null,
  gameId: string | null,
  fetchImpl: typeof fetch,
  timeoutMs = 2_000,
): Promise<{ projectId: string; gameId: string } | null> {
  if (!runtimeId || !gameId) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const options = { cache: 'no-store' as const, signal: controller.signal };
    const [healthResponse, activeResponse] = await Promise.all([
      fetchImpl('/api/health', options), fetchImpl('/api/projects/active', options),
    ]);
    if (!healthResponse.ok || !activeResponse.ok) return null;
    const [health, active] = await Promise.all([healthResponse.json(), activeResponse.json()]);
    if (typeof health?.instanceRootAbs !== 'string' || !health.instanceRootAbs || active?.activeSlug !== gameId) return null;
    return { projectId: health.instanceRootAbs, gameId };
  } catch { return null; }
  finally { clearTimeout(timer); }
}
