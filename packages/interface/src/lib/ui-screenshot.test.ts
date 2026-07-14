/** ui-screenshot(P3)单测 —— target 解析 + fail-soft 形状。
 *
 *  真栅格化(SVG-as-image → canvas)依赖真实浏览器,happy-dom 不加载图片,故此处只锁
 *  纯逻辑半边:target 解析(app / panel:<id> / display:contents 外壳)与未知 target 的
 *  captured:false fail-soft。像素路径由真栈 smoke 验证(049 §A.2 checklist)。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let registered = false;
beforeAll(async () => {
  if (typeof document === 'undefined') {
    GlobalRegistrator.register();
    registered = true;
  }
});
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

describe('resolveScreenshotTarget', () => {
  test("'app' → document.body;panel:<id> → DockPanel 结构标记内的面板体", async () => {
    const { resolveScreenshotTarget } = await import('./ui-screenshot');
    document.body.innerHTML =
      '<div data-fx-slot="DockPanel:chat" style="display: contents"><section id="chat-body">hi</section></div>';
    expect(resolveScreenshotTarget('app')).toBe(document.body);
    const panel = resolveScreenshotTarget('panel:chat');
    expect(panel?.id).toBe('chat-body'); // display:contents 外壳 → 取面板体
    expect(resolveScreenshotTarget('panel:nope')).toBeNull();
    expect(resolveScreenshotTarget('viewport')).toBeNull(); // 只认 app / panel:<id>
  });
});

describe('captureUiScreenshot — fail-soft', () => {
  test('未知 target → { captured:false, reason }(不抛)', async () => {
    const { captureUiScreenshot } = await import('./ui-screenshot');
    const out = (await captureUiScreenshot({ target: 'panel:missing' })) as { captured: boolean; reason: string };
    expect(out.captured).toBe(false);
    expect(out.reason).toContain('panel:missing');
  });
});
