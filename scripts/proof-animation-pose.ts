import type { Page } from 'playwright';

/** Match the finite-animation end pose used by animation-disabled screenshots
 * before reading visibility and geometry. Infinite motion is not certified here.
 */
export async function settleProofAnimationPose(page: Page): Promise<void> {
	await page.evaluate(() => {
		for (const animation of document.getAnimations()) {
			const end = animation.effect?.getComputedTiming().endTime;
			if (typeof end === 'number' && Number.isFinite(end) && animation.playState !== 'idle') {
				animation.finish();
			}
		}
	});
	await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
