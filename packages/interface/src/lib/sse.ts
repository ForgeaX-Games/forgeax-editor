// Minimal SSE parser over a fetch ReadableStream.
// Yields {event, data} frames; handles multi-line `data:` accumulation per spec.

export interface SseFrame {
  event: string;
  data: string;
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncIterable<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line === '') {
          if (event || data) yield { event, data };
          event = '';
          data = '';
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data += (data ? '\n' : '') + line.slice(5).trim();
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
