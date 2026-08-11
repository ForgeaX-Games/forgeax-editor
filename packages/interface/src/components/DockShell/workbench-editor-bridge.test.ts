import { describe, expect, test } from 'bun:test';
import { attachWorkbenchEditorAssetImportBridge } from './workbench-editor-bridge';

describe('workbench Editor asset bridge', () => {
  test('forwards a standalone iframe request to the injected Editor callback', async () => {
    let listener: ((event: MessageEvent) => void) | undefined;
    const ownerWindow = {
      addEventListener: (_type: string, next: (event: MessageEvent) => void) => { listener = next; },
      removeEventListener: () => { listener = undefined; },
    } as unknown as Window;
    const replies: unknown[] = [];
    const frameWindow = {
      postMessage: (message: unknown) => { replies.push(message); },
    } as unknown as Window;
    let received: unknown;

    const detach = attachWorkbenchEditorAssetImportBridge({
      ownerWindow,
      frameWindow: () => frameWindow,
      importAssetSource: async (request) => {
        received = request;
        return { ok: true, requestId: request.requestId };
      },
    });

    listener?.({
      source: frameWindow,
      data: {
        type: 'workbench:editor-asset-import',
        requestId: 'request-1',
        destPath: 'assets/3d/robot.glb',
        sourceName: 'robot.glb',
        base64: 'Z2xi',
      },
    } as MessageEvent);
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toEqual({
      requestId: 'request-1',
      destPath: 'assets/3d/robot.glb',
      sourceName: 'robot.glb',
      base64: 'Z2xi',
    });
    expect(replies).toEqual([{
      type: 'workbench:editor-asset-import-result',
      requestId: 'request-1',
      ok: true,
      result: { ok: true, requestId: 'request-1' },
    }]);
    detach();
  });
});
