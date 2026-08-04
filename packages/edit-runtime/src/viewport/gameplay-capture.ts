const MAX_EDGE = 1920;
const RASTER_TIMEOUT_MS = 5_000;

function loadImage(doc: Document, source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = doc.createElement('img');
    const timer = globalThis.setTimeout(() => reject(new Error('viewport rasterization timed out')), RASTER_TIMEOUT_MS);
    image.onload = () => {
      globalThis.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      globalThis.clearTimeout(timer);
      reject(new Error('viewport rasterization failed'));
    };
    image.src = source;
  });
}

function freezeComputedStyle(source: Element, target: Element): void {
  const view = source.ownerDocument.defaultView;
  if (!view) return;
  const computed = view.getComputedStyle(source);
  const declarations: string[] = [];
  for (let index = 0; index < computed.length; index += 1) {
    const property = computed.item(index);
    declarations.push(`${property}:${computed.getPropertyValue(property)}${computed.getPropertyPriority(property) ? '!important' : ''}`);
  }
  target.setAttribute('style', declarations.join(';'));
}

/**
 * Clone the rendered (composed) tree rather than only the light DOM. Engine UI
 * assets intentionally mount in Shadow DOM, which cloneNode(true) omits. Styles
 * are frozen onto each element so flattening a shadow tree preserves its actual
 * pixels without leaking its selectors into the surrounding viewport chrome.
 */
function cloneRenderedNode(source: Node, renderCanvas: HTMLCanvasElement, doc: Document): Node | null {
  if (source.nodeType === Node.TEXT_NODE) return doc.createTextNode(source.textContent ?? '');
  if (!(source instanceof Element)) return null;
  if (source.localName === 'script' || source.localName === 'style') return null;

  if (source instanceof HTMLCanvasElement) {
    const image = doc.createElement('img');
    for (const attribute of Array.from(source.attributes)) image.setAttribute(attribute.name, attribute.value);
    image.src = source === renderCanvas
      ? renderCanvas.toDataURL('image/png')
      : source.toDataURL('image/png');
    image.width = source.width;
    image.height = source.height;
    freezeComputedStyle(source, image);
    return image;
  }

  if (source instanceof HTMLSlotElement) {
    const fragment = doc.createDocumentFragment();
    for (const assigned of source.assignedNodes({ flatten: true })) {
      const child = cloneRenderedNode(assigned, renderCanvas, doc);
      if (child) fragment.append(child);
    }
    return fragment;
  }

  const target = source.cloneNode(false) as Element;
  freezeComputedStyle(source, target);
  if (source instanceof HTMLInputElement && target instanceof HTMLInputElement) {
    target.value = source.value;
    target.checked = source.checked;
  } else if (source instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement) {
    target.textContent = source.value;
  } else if (source instanceof HTMLSelectElement && target instanceof HTMLSelectElement) {
    target.value = source.value;
  }

  const children = source.shadowRoot?.childNodes ?? source.childNodes;
  for (const childSource of Array.from(children)) {
    const child = cloneRenderedNode(childSource, renderCanvas, doc);
    if (child) target.append(child);
  }
  return target;
}

/** Capture the complete user-visible game surface: WebGPU canvas plus DOM HUD. */
export async function captureGameplayViewport(
  container: HTMLElement,
  renderCanvas: HTMLCanvasElement,
): Promise<string> {
  const doc = container.ownerDocument;
  const rect = container.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width || container.clientWidth));
  const height = Math.max(1, Math.ceil(rect.height || container.clientHeight));
  const scale = Math.min(globalThis.devicePixelRatio || 1, MAX_EDGE / Math.max(width, height));
  const clone = cloneRenderedNode(container, renderCanvas, doc);
  if (!(clone instanceof HTMLElement)) throw new Error('viewport capture could not clone the rendered surface');
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  const xhtml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">`
    + `${xhtml}</div></foreignObject></svg>`;
  const image = await loadImage(doc, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

  const output = doc.createElement('canvas');
  output.width = Math.max(1, Math.round(width * scale));
  output.height = Math.max(1, Math.round(height * scale));
  const context = output.getContext('2d');
  if (!context) throw new Error('viewport capture requires a 2D canvas context');
  context.drawImage(image, 0, 0, output.width, output.height);
  const dataUrl = output.toDataURL('image/png');
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('viewport capture produced no PNG data');
  return dataUrl;
}
