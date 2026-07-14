/** ui-screenshot —— `ui_screenshot`(方案 P3)的 interface 侧应答:web 形态 DOM→canvas
 *  兜底截屏(零依赖,foreignObject 栅格化路线)。
 *
 *  定位是**兜底证据,不是主感知通道**(主通道 = ui_snapshot 的文本 manifest + 状态摘要),
 *  故一切失败都 fail-soft 成 `{ captured:false, reason }`(契约 description 已叮嘱模型
 *  勿重试)。已知呈现局限(SVG-as-image 上下文**不加载任何外部资源**):
 *  - webfont 回退系统字体;<img> / 跨源 iframe / GPU 合成 canvas 呈空白;
 *  - WebKit(桌面 WKWebView)对 foreignObject→canvas 有已知渲染缺陷 → 大概率走
 *    fail-soft 分支;Tauri 原生截屏是后续增强(方案 P3 注)。
 *
 *  target 解析:'app'(默认)= document.body;'panel:<id>' = DockPanelHost 的结构标记
 *  `[data-fx-slot="DockPanel:<id>"]`(其外壳 display:contents 量不出 rect,故实际
 *  量测/序列化首个元素子节点)。
 */

/** 长边上限:压 payload,同时贴近视觉模型的甜点分辨率。 */
const MAX_EDGE = 1568;
const JPEG_QUALITY = 0.85;

export interface ScreenshotOk {
  dataUrl: string;
  width: number;
  height: number;
  target: string;
  note: string;
}

export interface ScreenshotFail {
  captured: false;
  reason: string;
  target?: string;
}

/** 解析截屏目标元素;认不出 → null(调用方回 captured:false)。 */
export function resolveScreenshotTarget(target: string): HTMLElement | null {
  if (target === 'app') return document.body;
  if (target.startsWith('panel:')) {
    const id = target.slice('panel:'.length);
    const host = document.querySelector(`[data-fx-slot="DockPanel:${CSS.escape(id)}"]`);
    if (!(host instanceof HTMLElement)) return null;
    // 外壳 display:contents(见 DockPanelHost)→ 用首个元素子节点量测/序列化。
    const body = host.firstElementChild;
    return body instanceof HTMLElement ? body : host;
  }
  return null;
}

/** 汇总同源样式表文本(跨源 cssRules 读取会抛 → 跳过;外链字体反正不加载)。 */
function collectSameOriginCss(): string {
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) chunks.push(rule.cssText);
    } catch {
      /* 跨源样式表 → 跳过(对应区域回退无样式,兜底证据可接受) */
    }
  }
  // <style> 内容走 CDATA 包裹,CSS 里理论上不会出现的终结子串防御性剔除。
  return chunks.join('\n').replaceAll(']]>', '');
}

/** 克隆并去掉序列化无意义/有害的活性节点(script 不该出现在图里;其余空白节点保留占位)。 */
function cloneForSerialization(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const s of Array.from(clone.querySelectorAll('script'))) s.remove();
  return clone;
}

/** 栅格化图片加载超时:UI 侧必须先于编排层的通道超时(15s)给出确定答复。 */
const RASTER_TIMEOUT_MS = 5_000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('svg rasterization timed out')), RASTER_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('svg rasterization failed to load'));
    };
    img.src = src;
  });
}

/** 应答 `ui_screenshot` 查询:成功 `{ dataUrl, width, height, target, note }`,
 *  失败一律 `{ captured:false, reason }`(fail-soft,勿重试语义由契约承担)。 */
export async function captureUiScreenshot(query: unknown): Promise<ScreenshotOk | ScreenshotFail> {
  const q = (query ?? {}) as { target?: unknown };
  const target = typeof q.target === 'string' && q.target ? q.target : 'app';
  const el = resolveScreenshotTarget(target);
  if (!el) {
    return { captured: false, reason: `unknown target "${target}" — use 'app' or 'panel:<id>'`, target };
  }
  try {
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(rect.width || el.scrollWidth));
    const h = Math.max(1, Math.ceil(rect.height || el.scrollHeight));
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));

    const css = collectSameOriginCss();
    const xhtml = new XMLSerializer().serializeToString(cloneForSerialization(el));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml"><style><![CDATA[${css}]]></style>${xhtml}</div>` +
      `</foreignObject></svg>`;
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { captured: false, reason: 'canvas 2d context unavailable', target };
    ctx.fillStyle = '#ffffff'; // JPEG 无 alpha,先铺白底
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);

    // 栅格失败/污染(toDataURL 抛 SecurityError)都会落到 catch → fail-soft。
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    if (!dataUrl.startsWith('data:image/')) {
      return { captured: false, reason: 'canvas produced no image data', target };
    }
    return {
      dataUrl,
      width: outW,
      height: outH,
      target,
      note: 'best-effort DOM rasterization: external images/fonts and embedded frames/canvases may render blank',
    };
  } catch (e) {
    return { captured: false, reason: `capture failed: ${(e as Error).message}`, target };
  }
}
