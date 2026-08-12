import { afterEach, describe, expect, test } from 'bun:test';
import { captureGameplayViewport } from '../gameplay-capture';

type Attribute = { readonly name: string; readonly value: string };

class FakeNode {
  readonly nodeType: number;
  readonly childNodes: FakeNode[] = [];
  textContent = '';

  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }

  append(child: FakeNode): void {
    this.childNodes.push(child);
  }
}

class FakeElement extends FakeNode {
  readonly attributes: Attribute[] = [];
  readonly localName: string;
  readonly ownerDocument: FakeDocument;
  readonly style = {
    cssText: '',
    width: '',
    height: '',
    setProperty: (name: string, value: string, priority?: string) => {
      this.style.cssText += `${name}:${value}${priority ? `!${priority}` : ''};`;
    },
  };
  shadowRoot: { readonly childNodes: FakeNode[] } | null = null;
  assigned: FakeNode[] = [];

  constructor(localName: string, ownerDocument: FakeDocument) {
    super(1);
    this.localName = localName;
    this.ownerDocument = ownerDocument;
  }

  cloneNode(): FakeElement {
    const clone = new FakeElement(this.localName, this.ownerDocument);
    for (const attribute of this.attributes) clone.setAttribute(attribute.name, attribute.value);
    return clone;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.push({ name, value });
  }

  getAttribute(name: string): string | null {
    return this.attributes.find((attribute) => attribute.name === name)?.value ?? null;
  }

  assignedNodes(): FakeNode[] {
    return this.assigned;
  }
}

class FakeCanvas extends FakeElement {
  width = 0;
  height = 0;
  toBlobCalls = 0;
  samplePixel: [number, number, number, number] = [0, 0, 0, 0];
  readonly draws: Array<{ readonly source: unknown; readonly width: number; readonly height: number }> = [];
  constructor(ownerDocument: FakeDocument) {
    super('canvas', ownerDocument);
  }
  toDataURL(): never {
    throw new Error('synchronous toDataURL must not be used');
  }
  getContext(type: string): { drawImage: (source: unknown, x: number, y: number, width: number, height: number) => void } | null {
    if (type !== '2d') return null;
    return {
      drawImage: (source, _x, _y, width, height) => {
        this.draws.push({ source, width, height });
        const pixel = (source as { samplePixel?: [number, number, number, number] }).samplePixel;
        if (pixel && pixel[3] > 0) this.samplePixel = [...pixel];
      },
    };
  }
  toBlob(callback: (blob: Blob | null) => void): void {
    this.toBlobCalls += 1;
    queueMicrotask(() => callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })));
  }
}

class FakeIframe extends FakeElement {
  contentDocument: FakeDocument | null = null;

  constructor(ownerDocument: FakeDocument) {
    super('iframe', ownerDocument);
    this.setAttribute('class', 'viewport-play-child');
    this.setAttribute('data-play-generation', '1');
  }
}

class FakeImage extends FakeElement {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  samplePixel: [number, number, number, number] = [220, 80, 30, 192];
  private source = '';

  constructor(ownerDocument: FakeDocument) {
    super('img', ownerDocument);
  }

  set src(value: string) {
    this.source = value;
    this.ownerDocument.imageSources.push(value);
    queueMicrotask(() => this.onload?.());
  }

  get src(): string {
    return this.source;
  }
}

class FakeDocument {
  readonly canvases: FakeCanvas[] = [];
  readonly imageSources: string[] = [];
  readonly pendingFrames: FrameRequestCallback[] = [];
  frameRequests = 0;
  autoPresentFrame = true;
  readonly defaultView = {
    getComputedStyle: (_element: FakeElement) => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      getPropertyValue: (_property: string) => '',
      getPropertyPriority: (_property: string) => '',
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      this.frameRequests += 1;
      if (this.autoPresentFrame) queueMicrotask(() => callback(performance.now()));
      else this.pendingFrames.push(callback);
      return this.frameRequests;
    },
  };

  presentFrame(): void {
    for (const callback of this.pendingFrames.splice(0)) callback(performance.now());
  }

  createElement(localName: string): FakeElement {
    if (localName === 'canvas') {
      const canvas = new FakeCanvas(this);
      this.canvases.push(canvas);
      return canvas;
    }
    if (localName === 'img') return new FakeImage(this);
    return new FakeElement(localName, this);
  }

  createTextNode(text: string): FakeNode {
    const node = new FakeNode(3);
    node.textContent = text;
    return node;
  }

  createDocumentFragment(): FakeElement {
    return new FakeElement('fragment', this);
  }
}

class FakeContainer extends FakeElement {
  readonly clientWidth: number;
  readonly clientHeight: number;
  private readonly hud: FakeElement | null;

  constructor(ownerDocument: FakeDocument, width: number, height: number, hud: FakeElement | null) {
    super('div', ownerDocument);
    this.clientWidth = width;
    this.clientHeight = height;
    this.hud = hud;
    if (hud) this.append(hud);
  }

  getBoundingClientRect(): { readonly width: number; readonly height: number } {
    return { width: this.clientWidth, height: this.clientHeight };
  }

  querySelector(selector: string): FakeElement | null {
    return selector === '#game-ui-root' ? this.hud : null;
  }
}

type MutableGlobals = {
  createImageBitmap?: (source: unknown) => Promise<{ close(): void }>;
  FileReader?: new () => {
    result: string | ArrayBuffer | null;
    error: Error | null;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    readAsDataURL(blob: Blob): void;
  };
  XMLSerializer?: new () => { serializeToString(node: unknown): string };
  devicePixelRatio?: number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
};

const globals = globalThis as unknown as MutableGlobals;
const originals = {
  createImageBitmap: globals.createImageBitmap,
  FileReader: globals.FileReader,
  XMLSerializer: globals.XMLSerializer,
  devicePixelRatio: globals.devicePixelRatio,
  setTimeout: globals.setTimeout,
  clearTimeout: globals.clearTimeout,
};
let readBlobs: Blob[] = [];

afterEach(() => {
  globals.createImageBitmap = originals.createImageBitmap;
  globals.FileReader = originals.FileReader;
  globals.XMLSerializer = originals.XMLSerializer;
  globals.devicePixelRatio = originals.devicePixelRatio;
  globals.setTimeout = originals.setTimeout;
  globals.clearTimeout = originals.clearTimeout;
  readBlobs = [];
});

function installRasterFakes(
  onBitmap: (source: unknown) => void,
  samplePixel: readonly number[] = [0, 0, 0, 0],
): void {
  globals.createImageBitmap = async (source) => {
    onBitmap(source);
    return { samplePixel, close() {} };
  };
  globals.FileReader = class {
    result: string | ArrayBuffer | null = null;
    error: Error | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob): void {
      readBlobs.push(blob);
      queueMicrotask(() => {
        this.result = `data:${blob.type};base64,iVBORw==`;
        this.onload?.();
      });
    }
  };
  globals.XMLSerializer = class {
    serializeToString(_node: unknown): string {
      return '<div xmlns="http://www.w3.org/1999/xhtml"></div>';
    }
  };
}

function makeHud(doc: FakeDocument, nodes: number): FakeElement {
  const root = new FakeElement('div', doc);
  root.setAttribute('id', 'game-ui-root');
  for (let index = 0; index < nodes; index += 1) {
    const child = new FakeElement('span', doc);
    child.textContent = `HUD-${index}`;
    root.append(child);
  }
  return root;
}

describe('gameplay viewport capture budgets', () => {
  test('bounds a high-resolution frame and fails explicitly before encoding an over-budget HUD', async () => {
    const doc = new FakeDocument();
    const hud = makeHud(doc, 1_000);
    const container = new FakeContainer(doc, 3_840, 2_160, hud);
    const renderCanvas = new FakeCanvas(doc);
    renderCanvas.width = 7_680;
    renderCanvas.height = 4_320;
    renderCanvas.samplePixel = [18, 72, 144, 255];
    globals.devicePixelRatio = 2;
    const bitmapSources: unknown[] = [];
    installRasterFakes((source) => bitmapSources.push(source));

    await expect(captureGameplayViewport(
      container as unknown as HTMLElement,
      renderCanvas as unknown as HTMLCanvasElement,
    )).rejects.toThrow('viewport HUD exceeds the capture complexity budget');

    const output = doc.canvases.at(-1)!;
    expect(output.width).toBe(1_920);
    expect(output.height).toBe(1_080);
    expect(output.width * output.height).toBeLessThanOrEqual(1_920 * 1_080);
    expect(bitmapSources).toEqual([]);
    expect(output.draws).toHaveLength(1);
    expect(output.samplePixel).toEqual([18, 72, 144, 255]);
    expect(output.toBlobCalls).toBe(0);
    expect(readBlobs).toEqual([]);
  });

  test('coalesces concurrent requests for one live canvas into a single capture', async () => {
    const doc = new FakeDocument();
    const container = new FakeContainer(doc, 1_920, 1_080, makeHud(doc, 0));
    const renderCanvas = new FakeCanvas(doc);
    renderCanvas.width = 3_840;
    renderCanvas.height = 2_160;
    doc.autoPresentFrame = false;
    installRasterFakes(() => {});

    const first = captureGameplayViewport(
      container as unknown as HTMLElement,
      renderCanvas as unknown as HTMLCanvasElement,
    );
    const second = captureGameplayViewport(
      container as unknown as HTMLElement,
      renderCanvas as unknown as HTMLCanvasElement,
    );
    await Promise.resolve();
    expect(doc.frameRequests).toBe(1);
    doc.presentFrame();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(doc.frameRequests).toBe(1);
  });

  test('rasterizes a bounded game HUD as a second transparent layer', async () => {
    const doc = new FakeDocument();
    const hud = makeHud(doc, 24);
    const container = new FakeContainer(doc, 1_280, 720, hud);
    const renderCanvas = new FakeCanvas(doc);
    renderCanvas.width = 2_560;
    renderCanvas.height = 1_440;
    const bitmapSources: unknown[] = [];
    installRasterFakes((source) => bitmapSources.push(source), [220, 80, 30, 192]);

    await captureGameplayViewport(
      container as unknown as HTMLElement,
      renderCanvas as unknown as HTMLCanvasElement,
    );

    const output = doc.canvases.at(-1)!;
    expect(bitmapSources).toEqual([]);
    expect(readBlobs.map((blob) => blob.type)).toEqual(['image/svg+xml', 'image/png']);
    expect(await readBlobs[0]!.text()).not.toContain('data:image/png');
    expect(doc.imageSources[0]).toStartWith('data:image/svg+xml;base64,');
    expect(output.draws).toHaveLength(2);
    expect(output.samplePixel).toEqual([220, 80, 30, 192]);
    expect(output.toBlobCalls).toBe(1);
    expect(output.draws[1]?.source).not.toBe(output.draws[0]?.source);
    expect(output.draws.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 1_280, height: 720 },
      { width: 1_280, height: 720 },
    ]);
  });

  test('finds only the viewport HUD through the bounded shadow and slot composed tree', async () => {
    const doc = new FakeDocument();
    const hud = makeHud(doc, 12);
    const slot = new FakeElement('slot', doc);
    slot.assigned = [hud];
    const shadowHost = new FakeElement('game-surface', doc);
    shadowHost.shadowRoot = { childNodes: [slot] };
    const container = new FakeContainer(doc, 1_280, 720, null);
    container.append(shadowHost);
    const renderCanvas = new FakeCanvas(doc);
    renderCanvas.samplePixel = [11, 22, 33, 255];
    const bitmapSources: unknown[] = [];
    installRasterFakes((source) => bitmapSources.push(source));

    await captureGameplayViewport(
      container as unknown as HTMLElement,
      renderCanvas as unknown as HTMLCanvasElement,
    );

    const output = doc.canvases.at(-1)!;
    expect(bitmapSources).toEqual([]);
    expect(readBlobs.map((blob) => blob.type)).toEqual(['image/svg+xml', 'image/png']);
    expect(doc.imageSources[0]).toStartWith('data:image/svg+xml;base64,');
    expect(output.draws).toHaveLength(2);
  });

  test('captures the active same-origin Play iframe surface instead of the edit canvas', async () => {
    const parentDoc = new FakeDocument();
    const childDoc = new FakeDocument();
    const childHud = makeHud(childDoc, 4);
    const childContainer = new FakeContainer(childDoc, 1_280, 720, childHud);
    const childCanvas = new FakeCanvas(childDoc);
    childCanvas.samplePixel = [19, 63, 121, 255];
    childContainer.append(childCanvas);
    (childDoc as unknown as { body: FakeContainer }).body = childContainer;

    const frame = new FakeIframe(parentDoc);
    frame.contentDocument = childDoc;
    const parentContainer = new FakeContainer(parentDoc, 1_280, 720, null);
    parentContainer.append(frame);
    const staleEditCanvas = new FakeCanvas(parentDoc);
    staleEditCanvas.samplePixel = [0, 0, 0, 255];
    installRasterFakes(() => {});

    await captureGameplayViewport(
      parentContainer as unknown as HTMLElement,
      staleEditCanvas as unknown as HTMLCanvasElement,
    );

    const output = childDoc.canvases.at(-1)!;
    expect(output.draws[0]?.source).toBe(childCanvas);
    expect(output.draws[0]?.source).not.toBe(staleEditCanvas);
    expect(output.samplePixel).toEqual([220, 80, 30, 192]);
    expect(parentDoc.canvases).toHaveLength(0);
    expect(readBlobs.map((blob) => blob.type)).toEqual(['image/svg+xml', 'image/png']);
  });

  test('copies non-black pixels from the presented WebGPU canvas instead of an async canvas bitmap', async () => {
    const doc = new FakeDocument();
    const container = new FakeContainer(doc, 1_600, 900, makeHud(doc, 0));
    const renderCanvas = new FakeCanvas(doc);
    renderCanvas.width = 3_200;
    renderCanvas.height = 1_800;
    renderCanvas.samplePixel = [7, 41, 113, 255];
    const bitmapSources: unknown[] = [];
    installRasterFakes((source) => bitmapSources.push(source));

    await captureGameplayViewport(
      container as unknown as HTMLElement,
      renderCanvas as unknown as HTMLCanvasElement,
    );

    const output = doc.canvases.at(-1)!;
    expect(doc.frameRequests).toBe(1);
    expect(output.draws[0]?.source).toBe(renderCanvas);
    expect((output.draws[0]?.source as FakeCanvas).samplePixel).toEqual([7, 41, 113, 255]);
    expect(bitmapSources).toEqual([]);
  });

  test('fails explicitly when the live Play HUD root is unavailable', async () => {
    const doc = new FakeDocument();
    const container = new FakeContainer(doc, 1_280, 720, null);
    const renderCanvas = new FakeCanvas(doc);
    installRasterFakes(() => {});

    await expect(captureGameplayViewport(
      container as unknown as HTMLElement,
      renderCanvas as unknown as HTMLCanvasElement,
    )).rejects.toThrow('viewport HUD root is unavailable');

    expect(doc.canvases.at(-1)?.toBlobCalls).toBe(0);
    expect(readBlobs).toEqual([]);
  });

  test('fails explicitly instead of searching an unbounded composed HUD tree', async () => {
    const doc = new FakeDocument();
    const container = new FakeContainer(doc, 1_280, 720, null);
    for (let index = 0; index < 1_100; index += 1) {
      container.append(new FakeElement('div', doc));
    }
    const renderCanvas = new FakeCanvas(doc);
    installRasterFakes(() => {});

    await expect(captureGameplayViewport(
      container as unknown as HTMLElement,
      renderCanvas as unknown as HTMLCanvasElement,
    )).rejects.toThrow('viewport HUD exceeds the capture complexity budget');

    expect(doc.canvases.at(-1)?.toBlobCalls).toBe(0);
    expect(readBlobs).toEqual([]);
  });

  test('fails explicitly instead of dropping unsupported visual HUD content', async () => {
    const doc = new FakeDocument();
    const hud = makeHud(doc, 0);
    hud.append(new FakeCanvas(doc));
    const container = new FakeContainer(doc, 1_280, 720, hud);
    const renderCanvas = new FakeCanvas(doc);
    installRasterFakes(() => {});

    await expect(captureGameplayViewport(
      container as unknown as HTMLElement,
      renderCanvas as unknown as HTMLCanvasElement,
    )).rejects.toThrow('viewport HUD contains unsupported <canvas> content');

    expect(doc.canvases.at(-1)?.toBlobCalls).toBe(0);
    expect(readBlobs).toEqual([]);
  });

  test('aborts a stalled presented frame at the capture deadline', async () => {
    const doc = new FakeDocument();
    const container = new FakeContainer(doc, 1_280, 720, makeHud(doc, 0));
    const renderCanvas = new FakeCanvas(doc);
    doc.autoPresentFrame = false;
    installRasterFakes(() => {});
    let deadline: (() => void) | undefined;
    globals.setTimeout = ((callback: TimerHandler) => {
      deadline = () => typeof callback === 'function' && callback();
      return 1;
    }) as typeof globalThis.setTimeout;
    globals.clearTimeout = (() => {}) as typeof globalThis.clearTimeout;

    const capture = captureGameplayViewport(
      container as unknown as HTMLElement,
      renderCanvas as unknown as HTMLCanvasElement,
    );
    expect(deadline).toBeDefined();
    deadline?.();

    await expect(capture).rejects.toThrow('viewport capture timed out');
    expect(doc.canvases.at(-1)?.toBlobCalls).toBe(0);
  });
});
