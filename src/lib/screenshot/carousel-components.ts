import type { Page } from 'playwright';
import type { CapturedComponent } from './component-states.js';

export interface Slideshow {
	initial: number;
	frames: Array<{ id: string; html: string; media: Array<{ asset: string }> }>;
	navigation: Array<{ mode: 'arrows' | 'dots' | 'keyboard' | 'swipe' | 'autoplay'; intervalMs?: number }>;
	views: Array<{ width: number; framesPerView: number }>;
	/** Private observation coordinates, retained for bounded exploration. */
	slots: string[];
	active: number;
	next?: string;
	previous?: string;
}

/** Read before exploration. Identity is a source slot, never an image URL. */
export async function snapshotCarousels(page: Page): Promise<CapturedComponent[]> {
	return page.evaluate(() => {
		const path = (element: Element): string => {
			if (element.id) return '#' + CSS.escape(element.id);
			const parts: string[] = [];
			for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
				const siblings = Array.from(node.parentElement!.children).filter(sibling => sibling.tagName === node!.tagName);
				parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
			}
			return 'body > ' + parts.join(' > ');
		};
		const direction = (element: Element, name: string) => new RegExp(`(^|[^a-z])${name}([^a-z]|$)`, 'i').test([element.id, element.className, element.getAttribute('aria-label'), ...Array.from(element.querySelectorAll('svg,[data-direction]')).map(icon => `${icon.getAttribute('class')} ${icon.getAttribute('data-direction')}`)].join(' '));
		const roots = new Set<Element>(document.querySelectorAll('[aria-roledescription="carousel"]'));
		for (const next of document.querySelectorAll('button,[role="button"]')) {
			if (!direction(next, 'next|forward|right')) continue;
			for (let root = next.parentElement, depth = 0; root && depth < 5; root = root.parentElement, depth++) {
				if (root.querySelectorAll('img').length >= 2 && Array.from(root.querySelectorAll('button,[role="button"]')).some(control => direction(control, 'prev|previous|back|left'))) { roots.add(root); break; }
			}
		}
		const result: CapturedComponent[] = [];
		for (const root of Array.from(roots).slice(0, 8)) {
			if (result.some(node => document.querySelector(node.selector)?.contains(root))) continue;
			const explicit = Array.from(root.querySelectorAll('[aria-roledescription="slide"],[role="slide"]'));
			const track = Array.from(root.querySelectorAll('*')).find(element => element.children.length >= 2 && Array.from(element.children).every(child => child.matches('img') || child.querySelector('img')));
			const slots = (explicit.length ? explicit : Array.from(track?.children ?? [])).filter(element => !element.matches('[data-clone],[data-cloned="true"],.slick-cloned,.swiper-slide-duplicate,[aria-roledescription="clone"]'));
			if (slots.length < 2 || slots.length > 64 || !root.querySelector('img')) continue;
			if (!explicit.length && (!track || !['flex', 'grid'].includes(getComputedStyle(track).display) && getComputedStyle(track).transform === 'none')) continue;
			const box = root.getBoundingClientRect();
			const visible = slots.map((slot, index) => {
				const rect = slot.getBoundingClientRect(); const style = getComputedStyle(slot);
				return { index, area: style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 ? 0 : Math.max(0, Math.min(rect.right, box.right) - Math.max(rect.left, box.left)) * Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top)), width: rect.width };
			});
			const selected = slots.findIndex(slot => slot.getAttribute('aria-current') === 'true' || slot.getAttribute('aria-selected') === 'true');
			const active = selected >= 0 ? selected : visible.reduce((best, item) => item.area > best.area ? item : best).index;
			const buttons = Array.from(root.querySelectorAll('button,[role="button"]'));
			const next = buttons.find(control => direction(control, 'next|forward|right'));
			const previous = buttons.find(control => direction(control, 'prev|previous|back|left'));
			const slideshow: Slideshow = {
				initial: active, active, slots: slots.map(path), frames: slots.map((slot, index) => ({ id: `slide-${index}`, html: slot.outerHTML, media: [] })), navigation: [],
				views: [{ width: innerWidth, framesPerView: visible.filter(item => item.width > 0 && item.area > item.width * Math.min(box.height, slots[item.index]!.getBoundingClientRect().height) * 0.5).length }],
				...(next ? { next: path(next) } : {}), ...(previous ? { previous: path(previous) } : {}),
			};
			result.push({ selector: path(root), kind: 'carousel', function: 'slideshow', initial: `slide-${active}`, states: [{ id: `slide-${active}`, html: root.outerHTML }], transitions: [], status: 'partial', slideshow });
		}
		return result;
	});
}

async function observe(page: Page, component: CapturedComponent): Promise<number> {
	const show = component.slideshow!;
	const observation = await page.evaluate(({ selector, slots }) => {
		const root = document.querySelector(selector); if (!root) return null;
		const box = root.getBoundingClientRect();
		return slots.map(selector => {
			const slot = document.querySelector(selector); if (!slot) return null;
			const rect = slot.getBoundingClientRect(); const style = getComputedStyle(slot);
			const area = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 ? 0 : Math.max(0, Math.min(rect.right, box.right) - Math.max(rect.left, box.left)) * Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top));
			const images = Array.from(slot.matches('img') ? [slot as HTMLImageElement] : slot.querySelectorAll('img'));
			const media = images.filter(image => image.complete && image.naturalWidth > 1 && (!image.hasAttribute('data-src') || image.currentSrc === new URL(image.getAttribute('data-src')!, document.baseURI).href)).map(image => ({ asset: image.currentSrc || image.src }));
			return { area, html: slot.outerHTML, media, ready: images.length > 0 && media.length === images.length };
		});
	}, { selector: component.selector, slots: show.slots });
	if (!observation) return show.active;
	let active = 0;
	observation.forEach((item, index) => {
		if (item && item.area > (observation[active]?.area ?? 0)) active = index;
		if (item?.ready && item.area > 0) show.frames[index] = { id: `slide-${index}`, html: item.html, media: item.media };
	});
	show.active = active;
	return active;
}

/** Explore through source controls; never return replacement route markup. */
export async function exploreCarousel(page: Page, component: CapturedComponent): Promise<void> {
	const show = component.slideshow!;
	const initial = show.initial;
	const record = async (mode: Slideshow['navigation'][number]['mode'], action: () => Promise<unknown>, selector: string, trigger: 'click' | 'keyboard' | 'swipe') => {
		const before = await observe(page, component);
		await action(); await page.waitForTimeout(160);
		const after = await observe(page, component);
		if (before !== after) {
			if (!show.navigation.some(item => item.mode === mode)) show.navigation.push({ mode });
			component.transitions.push({ from: `slide-${before}`, to: `slide-${after}`, trigger: { selector, action: trigger } });
		}
		return before !== after;
	};
	await observe(page, component);
	// Passive changes are the only evidence for autoplay; never infer it from a counter.
	const passiveStart = show.active;
	let firstAdvance: number | undefined;
	const watchStart = Date.now();
	for (let tick = 0; tick < 12; tick++) {
		await page.waitForTimeout(250);
		const before = show.active;
		await observe(page, component);
		if (show.active !== before) {
			const now = Date.now();
			if (firstAdvance !== undefined) { show.navigation.push({ mode: 'autoplay', intervalMs: now - firstAdvance }); break; }
			firstAdvance = now;
		}
	}
	if (show.active !== passiveStart && !show.navigation.some(item => item.mode === 'autoplay')) component.reason = `automatic change observed within ${Date.now() - watchStart}ms; interval unproven`;
	if (show.next) {
		for (let step = 0; step < show.frames.length; step++) {
			if (!await record('arrows', () => page.locator(show.next!).click({ timeout: 1000 }), show.next, 'click')) break;
			if (show.frames.every(frame => frame.media.length > 0) && show.active === initial) break;
		}
	}
	for (const dot of await page.locator(component.selector).locator('[role="tab"],button[aria-label*="slide" i],button[aria-label*="frame" i]').all()) {
		const selector = await dot.evaluate(element => { if (!element.id) return ''; return '#' + CSS.escape(element.id); });
		if (selector) await record('dots', () => dot.click({ timeout: 1000 }), selector, 'click');
	}
	// Keyboard and touch are attested only when the source actually changes selection.
	await page.locator(component.selector).evaluate(root => { (root as HTMLElement).focus({ preventScroll: true }); });
	await record('keyboard', () => page.keyboard.press('ArrowRight'), component.selector, 'keyboard');
	const box = await page.locator(component.selector).boundingBox();
	const swipe = async () => {
		await page.locator(component.selector).evaluate(root => {
			const box = root.getBoundingClientRect();
			const touch = (x: number) => new Touch({ identifier: 1, target: root, clientX: x, clientY: box.y + box.height / 2 });
			root.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(box.x + box.width * .8)], changedTouches: [touch(box.x + box.width * .8)] }));
			root.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(box.x + box.width * .2)], changedTouches: [touch(box.x + box.width * .2)] }));
			root.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(box.x + box.width * .2)] }));
		});
	};
	if (box) {
		for (let step = 0; step < (show.next ? 1 : show.frames.length * 2); step++) {
			let changed = false;
			try { changed = await record('swipe', swipe, component.selector, 'swipe'); } catch { /* This browser identity may not expose touch events. */ }
			if (!changed) break;
			if (!show.next && show.active === initial && show.frames.every(frame => frame.media.length > 0)) break;
		}
	}
	if (show.next) for (let step = 0; show.active !== initial && step < show.frames.length; step++) {
		const forward = (initial - show.active + show.frames.length) % show.frames.length;
		const backward = (show.active - initial + show.frames.length) % show.frames.length;
		await page.locator(show.previous && backward < forward ? show.previous : show.next).click({ timeout: 1000 });
		await page.waitForTimeout(160); await observe(page, component);
	}
	component.states = show.frames.map(frame => ({ id: frame.id, html: frame.html }));
	component.status = show.frames.every(frame => frame.media.length > 0) ? 'captured' : 'partial';
	if (component.status === 'partial') component.reason = 'some logical frames have no decoded media';
}
