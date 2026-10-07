import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { settleProofAnimationPose } from './proof-animation-pose.js';

describe('proof screenshot animation pose', () => {
	it('records the same finite-fade visibility and geometry before and after the screenshot', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			for (const width of [390, 768, 1440]) {
				await page.setViewportSize({ width, height: 900 });
				await page.setContent(`<!doctype html><style>body{margin:0}#image{width:120px;height:80px;opacity:0;animation:fade 60s forwards}@keyframes fade{to{opacity:1}}</style><div id="image" role="img" aria-label="Fading image"></div>`);
				const observation = () => page.locator('#image').evaluate(node => ({
					opacity: getComputedStyle(node).opacity,
					visible: node.checkVisibility({ checkOpacity: true }),
					width: node.getBoundingClientRect().width,
					height: node.getBoundingClientRect().height,
				}));
				expect(Number((await observation()).opacity)).toBeLessThan(0.5);
				await settleProofAnimationPose(page);
				const before = await observation();
				expect(before).toEqual({ opacity: '1', visible: true, width: 120, height: 80 });
				await page.screenshot({ fullPage: true, animations: 'disabled' });
				expect(await observation()).toEqual(before);
			}
		} finally { await browser.close(); }
	});
});
