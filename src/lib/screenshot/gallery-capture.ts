import type { Page } from 'playwright';
import type { CapturedDialogInteraction } from './interaction-capture.js';

/** A finite, observed cycle. Each frame occurs once in the authoring tree. */
export interface CapturedGallery {
	selector: string;
	stage: string;
	next: string;
	previous: string;
	/** Authored rendered DOM order, when all frames are already materialized. */
	order: string[];
	initial: number;
	frames: Array<{ key: string; html: string; text: Array<{ selector: string; value: string }> }>;
	coverage: 'complete' | 'partial';
	restoration: 'verified' | 'unverified';
	/** Timing is deliberately not inferred from the captured index. */
	autoplay: 'unmeasured';
}

const LIMIT = 24;
const BUDGET = 512 * 1024;

/** Find a rendered image stage beside labelled directional controls, without vendor classes. */
async function describe(
	page: Page,
	root: string,
): Promise<Omit<
	CapturedGallery,
	'frames' | 'initial' | 'coverage' | 'restoration' | 'autoplay'
> | null> {
	return page
		.locator(root)
		.first()
		.evaluate((scope) => {
			const path = (element: Element, ancestor: Element): string => {
				const parts: string[] = [];
				for (
					let node: Element | null = element;
					node && node !== ancestor;
					node = node.parentElement
				) {
					const siblings = Array.from(node.parentElement!.children).filter(
						(sibling) => sibling.tagName === node!.tagName,
					);
					parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
				}
				return ':scope > ' + parts.join(' > ');
			};
			const controls = Array.from(scope.querySelectorAll('button,[role="button"]'));
			const name = (el: Element) => el.getAttribute('aria-label') || el.textContent || '';
			const next = controls.find((el) => /^next (?:image|slide)$/i.test(name(el).trim()));
			const previous = controls.find((el) => /^previous (?:image|slide)$/i.test(name(el).trim()));
			if (!next || !previous) return null;
			const stage = Array.from(scope.querySelectorAll('*')).find((el) => {
				const children = Array.from(el.children);
				return (
					children.length >= 2 &&
					children.length <= 24 &&
					children.every((child) => child.tagName !== 'BUTTON') &&
					children.filter((child) => child.querySelector('img')).length >= 2 &&
					children.every((child) => !child.querySelector('a[href],button,[role="button"]'))
				);
			});
			if (!stage) return null;
			return {
				selector: '',
				stage: path(stage, scope),
				next: path(next, scope),
				previous: path(previous, scope),
				order: Array.from(stage.children)
					.map((child) => child.querySelector('img')?.src || '')
					.filter(Boolean),
			};
		})
		.then((result) => (result ? { ...result, selector: root } : null));
}

async function snapshot(page: Page, gallery: Pick<CapturedGallery, 'selector' | 'stage'>) {
	return page
		.locator(gallery.selector)
		.first()
		.evaluate((scope, stageSelector) => {
			const stage = scope.querySelector(stageSelector);
			if (!stage) return null;
			const rendered = Array.from(stage.children).filter((child) => {
				const image = child.querySelector('img');
				if (!image) return false;
				const rect = image.getBoundingClientRect();
				const x =
					Math.max(0, rect.left) + Math.min(rect.width, innerWidth - Math.max(0, rect.left)) / 2;
				const y =
					Math.max(0, rect.top) + Math.min(rect.height, innerHeight - Math.max(0, rect.top)) / 2;
				const hit = document.elementFromPoint(x, y);
				return rect.width > 0 && rect.height > 0 && hit !== null && child.contains(hit);
			});
			if (rendered.length !== 1) return null;
			const child = rendered[0]!;
			const image = child.querySelector('img')!;
			if (!image.complete || image.naturalWidth === 0) return null;
			const clone = child.cloneNode(true) as Element;
			for (const unsafe of clone.querySelectorAll('script,iframe,noscript')) unsafe.remove();
			for (const element of [clone, ...clone.querySelectorAll('*')]) {
				for (const attr of Array.from(element.attributes))
					if (/^on|^data-lib-/i.test(attr.name)) element.removeAttribute(attr.name);
			}
			const text: Array<{ selector: string; value: string }> = [];
			for (const el of scope.querySelectorAll('*')) {
				if (
					stage.contains(el) ||
					el.children.length ||
					!el.textContent?.trim() ||
					el.matches('script,style')
				)
					continue;
				const parts: string[] = [];
				for (let node: Element | null = el; node && node !== scope; node = node.parentElement) {
					const siblings = Array.from(node.parentElement!.children).filter(
						(sibling) => sibling.tagName === node!.tagName,
					);
					parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
				}
				text.push({ selector: ':scope > ' + parts.join(' > '), value: el.textContent });
			}
			return { key: image.src, html: clone.outerHTML, text };
		}, gallery.stage);
}

/** Require every edge and its inverse, including the wrap, before replaying a cycle. */
async function collect(
	page: Page,
	descriptor: Awaited<ReturnType<typeof describe>>,
): Promise<CapturedGallery | null> {
	if (!descriptor) return null;
	const first = await snapshot(page, descriptor);
	if (!first) return null;
	const frames = [first];
	const deadline = Date.now() + 120_000;
	const settle = async () => {
		await page.waitForTimeout(100);
		await page
			.locator(descriptor.selector)
			.first()
			.locator(descriptor.stage)
			.evaluate(async (stage) => {
				await Promise.all(
					stage
						.getAnimations({ subtree: true })
						.filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
						.map((animation) =>
							Promise.race([
								animation.finished.catch(() => undefined),
								new Promise((resolve) => setTimeout(resolve, 2500)),
							]),
						),
				);
			});
		await page.waitForTimeout(100);
	};
	let complete = false;
	for (let count = 0; count < LIMIT && Date.now() < deadline; count++) {
		const before = frames.at(-1)!;
		await page
			.locator(descriptor.selector)
			.first()
			.locator(descriptor.next)
			.click({ timeout: 2000 });
		await settle();
		let after: typeof first | null = null;
		for (let sample = 0; sample < 20; sample++) {
			await page.waitForTimeout(100);
			after = await snapshot(page, descriptor);
			if (after && after.key !== before.key) break;
		}
		if (!after || after.key === before.key) break;
		await settle();
		after = await snapshot(page, descriptor);
		if (!after) break;
		// The same action must not silently mean a fixed choice. Verify its inverse.
		await page
			.locator(descriptor.selector)
			.first()
			.locator(descriptor.previous)
			.click({ timeout: 2000 });
		await settle();
		if ((await snapshot(page, descriptor))?.key !== before.key) break;
		await page
			.locator(descriptor.selector)
			.first()
			.locator(descriptor.next)
			.click({ timeout: 2000 });
		await settle();
		if ((await snapshot(page, descriptor))?.key !== after.key) break;
		if (after.key === first.key) {
			complete = frames.length >= 2;
			break;
		}
		if (frames.some((frame) => frame.key === after!.key)) break;
		frames.push(after);
		if (Buffer.byteLength(JSON.stringify(frames)) > BUDGET) {
			frames.pop();
			break;
		}
	}
	const sourceInitial = descriptor.order.indexOf(first.key);
	const ordered =
		complete &&
		descriptor.order.length === frames.length &&
		frames.every(
			(frame, index) => frame.key === descriptor.order[(sourceInitial + index) % frames.length],
		)
			? descriptor.order.map((key) => frames.find((frame) => frame.key === key)!)
			: frames;
	return {
		...descriptor,
		initial: ordered.findIndex((frame) => frame.key === first.key),
		frames: ordered,
		coverage: complete ? 'complete' : 'partial',
		restoration: (await snapshot(page, descriptor))?.key === first.key ? 'verified' : 'unverified',
		autoplay: 'unmeasured',
	};
}

/** Gallery evidence travels through interaction-states and its existing HTML/media export. */
export async function captureGalleries(page: Page): Promise<CapturedDialogInteraction[]> {
	await page.evaluate(() => {
		(globalThis as typeof globalThis & { __name?: (fn: unknown) => unknown }).__name ??= (fn) => fn;
	});
	const roots = await page.evaluate(() =>
		Array.from(document.querySelectorAll('[aria-label]'))
			.filter((el) =>
				/gallery.*carousel|carousel.*gallery/i.test(el.getAttribute('aria-label') || ''),
			)
			.slice(0, 2)
			.map((el) => {
				let scope = el.parentElement;
				for (let depth = 0; scope && depth < 8; depth++, scope = scope.parentElement) {
					if (
						scope.querySelector('[aria-label="Next image"]') &&
						scope.querySelector('[aria-label="Previous image"]')
					) {
						if (!scope.id) continue;
						return '#' + CSS.escape(scope.id);
					}
				}
				return '';
			})
			.filter(Boolean),
	);
	const states: CapturedDialogInteraction[] = [];
	for (const root of roots) {
		await page.locator(root).scrollIntoViewIfNeeded();
		let inline: CapturedGallery | null;
		try {
			inline = await collect(page, await describe(page, root));
		} catch (error) {
			states.push({
				status: 'click-failed',
				kind: 'gallery',
				trigger: { selector: root, tag: 'div', ariaHaspopup: '', dataBindings: {} },
				error: String(error).slice(0, 500),
			});
			continue;
		}
		if (!inline) continue;
		const state: CapturedDialogInteraction = {
			status: 'no-dialog',
			kind: 'gallery',
			trigger: { selector: root, tag: 'div', ariaHaspopup: '', dataBindings: {} },
			gallery: { inline },
		};
		states.push(state);
		// Incomplete cycles remain evidence, never a guessed portable interaction.
		if (inline.coverage !== 'complete' || inline.restoration !== 'verified') continue;
		const before = await page.evaluate(() =>
			Array.from(document.body.children)
				.filter((el) => getComputedStyle(el).display !== 'none')
				.map((el) => el.id),
		);
		const opener = page
			.locator(root)
			.locator(inline.stage)
			.locator('img')
			.filter({ visible: true })
			.first();
		try {
			await opener.click({ timeout: 2000 });
		} catch (error) {
			state.error = String(error).slice(0, 500);
			continue;
		}
		await page.waitForTimeout(700);
		const overlay = await page.evaluate((before) => {
			const node = Array.from(document.body.children).find(
				(el) =>
					el.id &&
					!before.includes(el.id) &&
					getComputedStyle(el).display !== 'none' &&
					el.querySelector('[aria-label="Next slide"]') &&
					el.querySelector('[aria-label*="Close" i]'),
			);
			return node ? '#' + CSS.escape(node.id) : '';
		}, before);
		if (!overlay) {
			await page.keyboard.press('Escape');
			continue;
		}
		let lightbox: CapturedGallery | null = null;
		try {
			lightbox = await collect(page, await describe(page, overlay));
		} catch (error) {
			state.error = String(error).slice(0, 500);
		}
		if (lightbox) state.gallery!.lightbox = lightbox;
		const html = await page.locator(overlay).evaluate((el) => {
			const clone = el.cloneNode(true) as HTMLElement;
			for (const unsafe of clone.querySelectorAll('script,iframe,noscript')) unsafe.remove();
			for (const node of [clone, ...clone.querySelectorAll('*')])
				for (const attr of Array.from(node.attributes))
					if (/^on|^data-lib-/i.test(attr.name)) node.removeAttribute(attr.name);
			return clone.outerHTML;
		});
		state.dialog = {
			selector: overlay,
			tag: 'div',
			ariaModal: true,
			presentation: 'modal',
			html: Buffer.byteLength(html) > BUDGET ? '' : html,
			htmlBytes: Buffer.byteLength(html),
			htmlTruncated: Buffer.byteLength(html) > BUDGET,
		};
		state.trigger.selector = root + inline.stage.replace(':scope', '');
		const close = page.locator(overlay).locator('[aria-label*="Close" i]').first();
		await close.click({ timeout: 2000 }).catch((error) => {
			state.error = String(error).slice(0, 500);
		});
		await page.waitForTimeout(500);
		state.gallery!.closed = !(await page.locator(overlay).isVisible());
		if (
			lightbox?.coverage === 'complete' &&
			lightbox.restoration === 'verified' &&
			state.gallery!.closed
		)
			state.status = 'captured';
	}
	return states;
}
