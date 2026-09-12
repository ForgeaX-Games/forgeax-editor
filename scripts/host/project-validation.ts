/** Shared Node/Bun host adapter for the Editor-owned project validator. */
export async function handleProjectValidation(gameDir: string, request: Request): Promise<Response> {
  let options: { maxBytes?: number; maxEntities?: number };
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid options');
    options = {};
    for (const key of ['maxBytes', 'maxEntities'] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0) throw new Error('invalid limit');
      options[key] = body[key];
    }
  } catch {
    return Response.json({ ok: false, error: { code: 'INVALID_ARGS', hint: 'Project validation options must be an object with non-negative numeric limits.' } }, { status: 400 });
  }
  try {
    const { validateGameProject } = await import('../game-validation.mjs');
    return Response.json(await validateGameProject(gameDir, options));
  } catch (error) {
    return Response.json({ ok: false, error: {
      code: 'project-validation-unavailable',
      hint: error instanceof Error ? error.message : String(error),
      retryable: true, recoveryActions: ['run.retry', 'editor.discover'],
    } }, { status: 503 });
  }
}
