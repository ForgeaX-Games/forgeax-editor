export interface NativePickedFile {
  name: string;
  data: string;
  type?: string;
}

export type NativeImportPickResult =
  | { kind: 'selected'; files: File[] }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' };

interface NativePickResponse {
  ok?: unknown;
  cancelled?: unknown;
  files?: unknown;
}

function decodeBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * Ask the local Studio server for a native file dialog. The server owns the
 * OS-specific picker and returns file bytes; the browser fallback remains in
 * ContentBrowser for hosts that do not expose this local endpoint.
 */
export async function pickNativeImportFiles(initialDir: string): Promise<NativeImportPickResult> {
  try {
    const response = await fetch('/api/fs/pick-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initialDir, multiple: true }),
    });
    if (!response.ok) return { kind: 'unavailable' };
    const body = await response.json() as NativePickResponse;
    if (body.cancelled === true) return { kind: 'cancelled' };
    if (body.ok !== true || !Array.isArray(body.files)) return { kind: 'unavailable' };

    const files: File[] = [];
    for (const candidate of body.files) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const record = candidate as Record<string, unknown>;
      if (typeof record.name !== 'string' || typeof record.data !== 'string') continue;
      try {
        files.push(new File([decodeBase64(record.data)], record.name, {
          type: typeof record.type === 'string' ? record.type : '',
        }));
      } catch {
        // Ignore one malformed native entry while preserving other selections.
      }
    }
    return { kind: 'selected', files };
  } catch {
    return { kind: 'unavailable' };
  }
}
