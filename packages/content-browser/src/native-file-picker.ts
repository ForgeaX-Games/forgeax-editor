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

/** After one failed native pick, skip repeated `/api/fs/pick-files` probes. */
let nativeImportPickerCachedUnavailable: boolean | null = null;

/** True when a prior native pick proved this host has no working picker endpoint. */
export function isNativeImportPickerCachedUnavailable(): boolean {
  return nativeImportPickerCachedUnavailable === true;
}

/** Test-only reset for module-scoped picker availability cache. */
export function resetNativeImportPickerAvailabilityCacheForTests(): void {
  nativeImportPickerCachedUnavailable = null;
}

function markNativeImportPickerAvailable(): void {
  nativeImportPickerCachedUnavailable = false;
}

function markNativeImportPickerUnavailable(): void {
  nativeImportPickerCachedUnavailable = true;
}

/**
 * Ask the local Studio server for a native file dialog. The server owns the
 * OS-specific picker and returns file bytes; the browser fallback remains in
 * ContentBrowser for hosts that do not expose this local endpoint.
 */
export async function pickNativeImportFiles(initialDir: string): Promise<NativeImportPickResult> {
  if (nativeImportPickerCachedUnavailable === true) {
    return { kind: 'unavailable' };
  }
  try {
    const response = await fetch('/api/fs/pick-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initialDir, multiple: true }),
    });
    if (!response.ok) {
      markNativeImportPickerUnavailable();
      return { kind: 'unavailable' };
    }
    const body = await response.json() as NativePickResponse;
    if (body.cancelled === true) {
      markNativeImportPickerAvailable();
      return { kind: 'cancelled' };
    }
    if (body.ok !== true || !Array.isArray(body.files)) {
      markNativeImportPickerUnavailable();
      return { kind: 'unavailable' };
    }

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
    markNativeImportPickerAvailable();
    return { kind: 'selected', files };
  } catch {
    markNativeImportPickerUnavailable();
    return { kind: 'unavailable' };
  }
}
