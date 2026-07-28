export interface VideoGamePackageStatus {
  state?: string;
}

export async function getVideoGamePackageStatus(slug: string): Promise<VideoGamePackageStatus> {
  const response = await fetch(
    `/api/game-host/games/${encodeURIComponent(slug)}/package/status`,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function initializeVideoGamePackage(
  slug: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `/api/game-host/games/${encodeURIComponent(slug)}/package/initialize`,
      { method: "POST" },
    );
    const body = (await response.json().catch(() => ({}))) as {
      state?: string;
      error?: { hint?: string } | string;
    };
    const error = typeof body.error === "string" ? body.error : body.error?.hint;
    return response.ok && body.state === "initialized"
      ? { ok: true }
      : { ok: false, error: error ?? `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
