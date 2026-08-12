const MAX_EDGE = 1_920;
const MAX_PIXELS = 1_920 * 1_080;
const CAPTURE_TIMEOUT_MS = 5_000;
const HUD_MAX_ELEMENTS = 256;
const HUD_MAX_DEPTH = 32;
const HUD_SEARCH_MAX_NODES = 1_024;
const HUD_SEARCH_MAX_DEPTH = 48;
const HUD_MAX_TEXT_CHARS = 32_768;
const HUD_MAX_ATTRIBUTE_CHARS = 32_768;
const HUD_MAX_STYLE_CHARS = 128 * 1_024;
const HUD_MAX_SERIALIZED_BYTES = 256 * 1_024;

const HUD_STYLE_PROPERTIES = [
  'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index',
  'display', 'visibility', 'opacity', 'overflow', 'box-sizing',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'padding', 'gap',
  'flex', 'flex-direction', 'flex-wrap', 'align-items', 'align-content', 'justify-content',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'transform', 'transform-origin',
  'border', 'border-radius', 'outline',
  'background', 'box-shadow',
  'color', 'font', 'line-height', 'letter-spacing', 'text-align', 'text-shadow', 'text-transform',
  'white-space', 'object-fit', 'filter', 'backdrop-filter', 'clip-path',
] as const;

type CaptureSize = { readonly width: number; readonly height: number };
type HudBudget = { elements: number; textChars: number; attributeChars: number; styleChars: number };

class HudBudgetExceeded extends Error {}
class HudUnsupportedElement extends Error {
  constructor(readonly elementName: string) {
    super();
  }
}

const capturesInFlight = new WeakMap<HTMLCanvasElement, Promise<string>>();

function captureSize(width: number, height: number, devicePixelRatio: number): CaptureSize {
  const safeWidth = Math.max(1, Math.ceil(width));
  const safeHeight = Math.max(1, Math.ceil(height));
  const pixelScale = Math.sqrt(MAX_PIXELS / (safeWidth * safeHeight));
  const scale = Math.max(1 / Math.max(safeWidth, safeHeight), Math.min(
    Math.max(1, devicePixelRatio),
    MAX_EDGE / safeWidth,
    MAX_EDGE / safeHeight,
    pixelScale,
  ));
  return {
    width: Math.max(1, Math.floor(safeWidth * scale)),
    height: Math.max(1, Math.floor(safeHeight * scale)),
  };
}

function captureError(message: string): Error {
  return new Error(message);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error
    ? signal.reason
    : captureError('viewport capture timed out');
}

function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : captureError('viewport capture timed out'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  throwIfAborted(signal);
  return waitForAbortable(new Promise<Blob>((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(captureError('viewport capture requires asynchronous canvas encoding'));
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(captureError('viewport capture produced no PNG data'));
    }, 'image/png');
  }), signal);
}

function blobToDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return waitForAbortable(new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(captureError('viewport capture produced no PNG data'));
    reader.onerror = () => reject(reader.error ?? captureError('viewport capture could not encode PNG data'));
    reader.readAsDataURL(blob);
  }), signal);
}

async function loadDataUrlImage(doc: Document, blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  const source = await blobToDataUrl(blob, signal);
  if (!source.startsWith('data:image/svg+xml')) {
    throw captureError('viewport HUD could not be encoded as SVG');
  }
  return waitForAbortable(new Promise<HTMLImageElement>((resolve, reject) => {
    const image = doc.createElement('img');
    image.onload = () => resolve(image);
    image.onerror = () => reject(captureError('viewport HUD rasterization failed'));
    image.src = source;
  }), signal);
}

function waitForPresentedFrame(doc: Document, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const view = doc.defaultView;
  if (!view) return waitForAbortable(new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  }), signal);
  return waitForAbortable(new Promise<void>((resolve) => {
    view.requestAnimationFrame(() => resolve());
  }), signal);
}

function renderedChildren(source: Element): Iterable<Node> {
  if (source.localName === 'slot') {
    return (source as HTMLSlotElement).assignedNodes({ flatten: true });
  }
  return source.shadowRoot?.childNodes ?? source.childNodes;
}

function findComposedElementById(root: Element, id: string): Element | null {
  const queue: Array<{ readonly node: Node; readonly depth: number }> = [{ node: root, depth: 0 }];
  let cursor = 0;
  while (cursor < queue.length) {
    if (cursor >= HUD_SEARCH_MAX_NODES) throw new HudBudgetExceeded();
    const current = queue[cursor++];
    if (!current || current.node.nodeType !== 1) continue;
    const element = current.node as Element;
    if (element.getAttribute('id') === id) return element;
    for (const child of renderedChildren(element)) {
      if (current.depth >= HUD_SEARCH_MAX_DEPTH) throw new HudBudgetExceeded();
      if (queue.length >= HUD_SEARCH_MAX_NODES) throw new HudBudgetExceeded();
      queue.push({ node: child, depth: current.depth + 1 });
    }
  }
  return null;
}

function cloneHudNode(
  source: Node,
  doc: Document,
  budget: HudBudget,
  depth: number,
): Node | null {
  if (depth > HUD_MAX_DEPTH) throw new HudBudgetExceeded();
  if (source.nodeType === 3) {
    const text = source.textContent ?? '';
    budget.textChars += text.length;
    if (budget.textChars > HUD_MAX_TEXT_CHARS) throw new HudBudgetExceeded();
    return doc.createTextNode(text);
  }
  if (source.nodeType !== 1) return null;

  const element = source as Element;
  if (element.localName === 'script' || element.localName === 'style') return null;
  if (element.localName === 'canvas' || element.localName === 'video' || element.localName === 'iframe') {
    throw new HudUnsupportedElement(element.localName);
  }

  budget.elements += 1;
  for (const attribute of element.attributes) {
    budget.attributeChars += attribute.name.length + attribute.value.length;
  }
  if (budget.elements > HUD_MAX_ELEMENTS || budget.attributeChars > HUD_MAX_ATTRIBUTE_CHARS) {
    throw new HudBudgetExceeded();
  }

  const view = element.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(element);
  if (computed?.display === 'none' || computed?.visibility === 'hidden' || computed?.opacity === '0') return null;

  const target = element.cloneNode(false) as Element;
  if (computed) {
    const targetStyle = (target as HTMLElement | SVGElement).style;
    for (const property of HUD_STYLE_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) {
        budget.styleChars += property.length + value.length;
        if (budget.styleChars > HUD_MAX_STYLE_CHARS) throw new HudBudgetExceeded();
        targetStyle.setProperty(property, value, computed.getPropertyPriority(property));
      }
    }
  }

  if (element.localName === 'input') {
    (target as HTMLInputElement).value = (element as HTMLInputElement).value;
    (target as HTMLInputElement).checked = (element as HTMLInputElement).checked;
  } else if (element.localName === 'textarea') {
    target.textContent = (element as HTMLTextAreaElement).value;
  } else if (element.localName === 'select') {
    (target as HTMLSelectElement).value = (element as HTMLSelectElement).value;
  }

  for (const childSource of renderedChildren(element)) {
    const child = cloneHudNode(childSource, doc, budget, depth + 1);
    if (child) target.append(child);
  }
  return target;
}

function cloneHud(container: HTMLElement): Element | null {
  // The Editor viewport can itself live under product Shadow DOM. Search the
  // composed surface (including flattened slots), but clone only the one
  // viewport-owned HUD root and stop at the separate search budget.
  try {
    const root = findComposedElementById(container, 'game-ui-root');
    if (!root) throw captureError('viewport HUD root is unavailable');
    return cloneHudNode(root, container.ownerDocument, {
      elements: 0,
      textChars: 0,
      attributeChars: 0,
      styleChars: 0,
    }, 0) as Element | null;
  } catch (error) {
    if (error instanceof HudBudgetExceeded) {
      throw captureError('viewport HUD exceeds the capture complexity budget');
    }
    if (error instanceof HudUnsupportedElement) {
      throw captureError(`viewport HUD contains unsupported <${error.elementName}> content`);
    }
    throw error;
  }
}

async function drawCanvas(
  context: CanvasRenderingContext2D,
  renderCanvas: HTMLCanvasElement,
  output: CaptureSize,
  signal: AbortSignal,
): Promise<void> {
  // WebGPU's presented canvas can produce a successfully decoded but empty
  // createImageBitmap snapshot after presentation. Copy it synchronously during
  // the next animation frame instead: the renderer's already-scheduled frame
  // runs first, while the destination remains bounded to the capture pixel cap.
  await waitForPresentedFrame(renderCanvas.ownerDocument, signal);
  throwIfAborted(signal);
  context.drawImage(renderCanvas, 0, 0, output.width, output.height);
}

async function drawHud(
  context: CanvasRenderingContext2D,
  hud: Element | null,
  viewport: CaptureSize,
  output: CaptureSize,
  signal: AbortSignal,
): Promise<void> {
  if (!hud) return;
  throwIfAborted(signal);
  const serialized = new XMLSerializer().serializeToString(hud);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}">`
    + `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">`
    + `${serialized}</div></foreignObject></svg>`;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  if (blob.size > HUD_MAX_SERIALIZED_BYTES) {
    throw captureError('viewport HUD exceeds the serialized capture budget');
  }
  const image = await loadDataUrlImage(hud.ownerDocument, blob, signal);
  throwIfAborted(signal);
  context.drawImage(image, 0, 0, output.width, output.height);
}

async function performCapture(
  container: HTMLElement,
  renderCanvas: HTMLCanvasElement,
  signal: AbortSignal,
): Promise<string> {
  const doc = container.ownerDocument;
  const rect = container.getBoundingClientRect();
  const viewport = {
    width: Math.max(1, Math.ceil(rect.width || container.clientWidth)),
    height: Math.max(1, Math.ceil(rect.height || container.clientHeight)),
  };
  const dpr = doc.defaultView?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
  const size = captureSize(viewport.width, viewport.height, dpr);
  const output = doc.createElement('canvas');
  output.width = size.width;
  output.height = size.height;
  const context = output.getContext('2d');
  if (!context) throw captureError('viewport capture requires a 2D canvas context');

  await drawCanvas(context, renderCanvas, size, signal);
  await drawHud(context, cloneHud(container), viewport, size, signal);
  const dataUrl = await blobToDataUrl(await canvasToBlob(output, signal), signal);
  if (!dataUrl.startsWith('data:image/png;base64,')) {
    throw captureError('viewport capture produced no PNG data');
  }
  return dataUrl;
}

/**
 * Capture the live renderer and its viewport-local game HUD. One frame is capped
 * at 1080p/1920px, encoded exactly once with the asynchronous Blob API, and
 * coalesced per canvas so concurrent readers cannot multiply GPU/PNG work.
 */
export function captureGameplayViewport(
  container: HTMLElement,
  renderCanvas: HTMLCanvasElement,
): Promise<string> {
  const active = capturesInFlight.get(renderCanvas);
  if (active) return active;

  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(captureError('viewport capture timed out')),
    CAPTURE_TIMEOUT_MS,
  );
  const capture = performCapture(container, renderCanvas, controller.signal)
    .finally(() => globalThis.clearTimeout(timer));
  capturesInFlight.set(renderCanvas, capture);
  void capture.then(
    () => { if (capturesInFlight.get(renderCanvas) === capture) capturesInFlight.delete(renderCanvas); },
    () => { if (capturesInFlight.get(renderCanvas) === capture) capturesInFlight.delete(renderCanvas); },
  );
  return capture;
}
