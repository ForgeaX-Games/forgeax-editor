export async function clickVisibleTextInAnyFrame(page, text) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const locator = frame.getByText(text, { exact: true }).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.click();
        return frame.url();
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`visible gameplay action not found: ${JSON.stringify(text)}`);
}

async function waitForSelector(page, selector, visible) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(page.frames().map((frame) =>
      frame.locator(selector).first().isVisible().catch(() => false),
    ));
    if (states.some(Boolean) === visible) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`gameplay selector ${JSON.stringify(selector)} did not become ${visible ? 'visible' : 'hidden'}`);
}

export async function enterConfiguredGameplay(page, options = {}) {
  if (options.playClickText !== undefined) {
    await clickVisibleTextInAnyFrame(page, options.playClickText);
  }
  if (options.playBlockingSelector !== undefined) {
    await waitForSelector(page, options.playBlockingSelector, true);
  }
  if (options.playReadySelector !== undefined) {
    await waitForSelector(page, options.playReadySelector, true);
  }
  if (options.playBlockingSelector !== undefined) {
    await waitForSelector(page, options.playBlockingSelector, false);
  }
}
