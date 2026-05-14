import type { Page } from 'playwright';

/**
 * Wait for a page to reach a stable state after load.
 *
 *   goto('load') ──▶ settleMs wait ──▶ networkidle best-effort (5s max) ──▶ done
 *
 * Networkidle is wrapped in try/catch because chatty analytics (GA, Intercom)
 * can hold it open indefinitely; we don't want that to block capture.
 */
export async function waitForStable(page: Page, settleMs: number = 1000): Promise<void> {
  await page.waitForLoadState('load');
  if (settleMs > 0) {
    await new Promise((r) => setTimeout(r, settleMs));
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 5_000 });
  } catch {
    /* best-effort — analytics can keep network busy forever */
  }
}

/**
 * Scroll from top to bottom in 500px increments with 200ms between steps,
 * wait for networkidle (5s max, best-effort), scroll back to top. Triggers
 * lazy-loaded images so the subsequent screenshot captures actual content
 * instead of placeholders.
 */
export async function triggerLazyLoad(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      const step = 500;
      const pauseMs = 200;
      const total = document.documentElement.scrollHeight;
      for (let y = 0; y < total; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, pauseMs));
      }
      window.scrollTo(0, total);
    });
    try {
      await page.waitForLoadState('networkidle', { timeout: 5_000 });
    } catch { /* best-effort */ }
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch {
    /* if the page crashes or blocks our script, don't fail the capture */
  }
}

/**
 * Race a page.evaluate promise against a hard timeout. Chatty scripts or
 * hostile origins shouldn't hang the capture indefinitely.
 */
export async function withEvaluateTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`evaluate timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
