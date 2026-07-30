import { decodeNdjson, parseTransportMessage } from './protocol';
import { createTransportService, type TransportService } from './service';

export interface StdioCarrier {
  readonly service: TransportService;
  handleLine(line: string): Promise<string>;
  start(input: AsyncIterable<string | Uint8Array>, write: (line: string) => void): Promise<void>;
}

export function createStdioCarrier(service = createTransportService()): StdioCarrier {
  return {
    service,
    handleLine: (line) => service.handleLine(line),
    async start(input, write) {
      for await (const chunk of input) {
        const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        for (const parsed of decodeNdjson(text)) {
          if (!parsed.ok || !('method' in parsed.value)) {
            write(JSON.stringify({ error: parsed.ok ? { code: 'protocol-invalid-message', hint: 'request expected' } : parsed.error }) + '\n');
            continue;
          }
          write(await service.handleLine(JSON.stringify(parsed.value)));
        }
      }
    },
  };
}

export { parseTransportMessage };
