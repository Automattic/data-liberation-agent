import type { Page } from 'playwright';
import * as cheerio from 'cheerio';
import type { CapturedDialogInteraction } from './interaction-capture.js';
import { activateTrigger } from './interaction-capture.js';
import { srcsetReferences } from '../srcset.js';
import { settleDocument, withEvaluateTimeout } from './page-helpers.js';

/** A finite, observed cycle. Each frame occurs once in the authoring tree. */
export interface CapturedGallery {
	selector: string;
	stage: string;
	next: string;
	previous: string;
	viewport: { width: number; height: number };
	/** Authored rendered DOM order, when all frames are already materialized. */
	order: string[];
	initial: number;
	frames: Array<{ key: string; fullImage?: string; html: string; text: Array<{ selector: string; value: string }> }>;
	coverage: 'complete' | 'partial';
	restoration: 'verified' | 'unverified';
	/** Timing is deliberately not inferred from the captured index. */
	autoplay: 'unmeasured';
	failure?: string;
}

/** Collect every image reference observed in captured gallery frame markup. */
export function galleryFrameMediaUrls(
	states: readonly CapturedDialogInteraction[],
	baseUrl: string,
): string[] {
	const urls = new Set< string >();
	for ( const state of states ) {
		for ( const gallery of [ state.gallery?.inline, state.gallery?.lightbox ] ) {
			for ( const frame of gallery?.frames ?? [] ) {
				const $ = cheerio.load( frame.html );
				$( 'img[src],source[src],img[srcset],source[srcset]' ).each( ( _, element ) => {
					const node = $( element );
					const references = [ node.attr( 'src' ), ...srcsetReferences( node.attr( 'srcset' ) ?? '' ) ];
					for ( const reference of references ) {
						if ( ! reference ) continue;
						try { urls.add( new URL( reference, baseUrl ).href ); } catch { /* Ignore malformed media references. */ }
					}
				} );
			}
		}
	}
	return [ ...urls ];
}

const LIMIT = 24;
const BUDGET = 512 * 1024;

/** Find a rendered image stage beside labelled directional controls, without vendor classes. */
async function describe(
	page: Page,
	root: string,
): Promise<Omit<
	CapturedGallery,
	'frames' | 'initial' | 'coverage' | 'restoration' | 'autoplay' | 'failure'
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
			const next = controls.find((el) => /^next (?:image|slide|photo|photograph|picture)$/i.test(name(el).trim()));
			const previous = controls.find((el) => /^previous (?:image|slide|photo|photograph|picture)$/i.test(name(el).trim()));
			if (!next || !previous) return null;
			const stage = [scope, ...Array.from(scope.querySelectorAll('*'))].find((el) => {
				const children = Array.from(el.children);
				return (
					children.length >= 2 &&
					children.length <= 24 &&
					children.filter(child => child.matches('img') || child.querySelector('img')).length >= 2
				);
			});
			if (!stage) return null;
			return {
				selector: '',
				stage: stage === scope ? ':scope' : path(stage, scope),
				next: path(next, scope),
				previous: path(previous, scope),
				order: Array.from(stage.children)
					.map((child) => child.querySelector('[data-src]')?.getAttribute('data-src') || child.getAttribute('data-src') || child.querySelector('img')?.currentSrc || child.querySelector('img')?.src || '')
					.filter(Boolean).map(value => new URL(value, document.baseURI).href),
			};
		})
		.then((result) => (result ? { ...result, selector: root, viewport: page.viewportSize() ?? { width: 0, height: 0 } } : null));
}

async function snapshot(page: Page, gallery: Pick<CapturedGallery, 'selector' | 'stage'>) {
	return page
		.locator(gallery.selector)
		.first()
		.evaluate((scope, stageSelector) => {
			const stage = stageSelector === ':scope' ? scope : scope.querySelector(stageSelector);
			if (!stage) return null;
			const imageFor = (child: Element): HTMLImageElement | null => child.matches('img') ? child as HTMLImageElement : child.querySelector('img');
			const laidOut = Array.from(stage.children).filter(child => {
				const image = imageFor(child);
				if (!image) return false;
				const rect = image.getBoundingClientRect();
				if (!rect.width || !rect.height) return false;
				for (let node: Element | null = image; node; node = node.parentElement) {
					const style = getComputedStyle(node);
					if (style.visibility === 'hidden' || Number(style.opacity) < 0.1) return false;
				}
				return true;
			});
			// A different-height successor can be outside a nested scrollport after
			// its arrow was clicked. Normalize that activation movement before hit testing.
			if (laidOut.length === 1) imageFor(laidOut[0]!)!.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
			const images = Array.from(stage.querySelectorAll('img'));
			if (images.length >= 2 && Array.from(stage.children).filter(child => imageFor(child)).length >= 2 && images.every(image => image.parentElement && (image.parentElement === stage || image.parentElement.parentElement === stage) && getComputedStyle(image.parentElement).display !== 'none')) {
				if (images.some(image => !image.complete || image.naturalWidth <= 1)) return null;
				const sources = images.map(image => image.currentSrc || image.src);
				const clone = stage.cloneNode(true) as Element;
				Array.from(clone.querySelectorAll('img')).forEach((image, index) => { image.setAttribute('src', sources[index]!); image.removeAttribute('srcset'); image.removeAttribute('sizes'); });
				for (const unsafe of clone.querySelectorAll('script,iframe,noscript')) unsafe.remove();
				return { key: sources.join('\n'), html: clone.innerHTML, text: [], ordinal: undefined, slot: 0, geometry: [], slots: sources };
			}
			const rendered = Array.from(stage.children).filter((child) => {
				const image = imageFor(child);
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
			if (!image.complete || image.naturalWidth <= 1) return null;
			const source = image.currentSrc || image.src;
			const clone = child.cloneNode(true) as Element;
			// A settled frame's resolved transform is its presentation. Neighbour
			// transition classes in the source must not move it again after serialization.
			(clone as HTMLElement).style.transform = getComputedStyle(child).transform;
			(clone as HTMLElement).style.display = getComputedStyle(child).display;
			const capturedImage = clone.querySelector('img')!;
			capturedImage.setAttribute('src', source);
			capturedImage.removeAttribute('srcset');
			capturedImage.removeAttribute('sizes');
			for (const source of clone.querySelectorAll('picture source')) source.remove();
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
			const fullImage = child.querySelector('[data-src]')?.getAttribute('data-src') || child.getAttribute('data-src');
			const key = fullImage ? new URL(fullImage, document.baseURI).href : source;
			const rect = child.getBoundingClientRect();
			const ordinal = image.hasAttribute('data-index') ? Number(image.getAttribute('data-index')) : undefined;
			return { key, ...(fullImage ? { fullImage: new URL(fullImage, document.baseURI).href } : {}), html: clone.outerHTML, text, ordinal, slot: Array.from(stage.children).indexOf(child), geometry:[rect.x,rect.y,rect.width,rect.height].map(value=>Math.round(value*10)/10) };
		}, gallery.stage);
}

/** Require every edge and its inverse, including the wrap, before replaying a cycle. */
async function collect(
	page: Page,
	descriptor: Awaited<ReturnType<typeof describe>>,
): Promise<CapturedGallery | null> {
	if (!descriptor) return null;
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
	// Capture can arrive during an authored automatic transition or lazy decode.
	// Settle the rendered stage before assigning the cycle's initial identity.
	await settle();
	let first = await snapshot(page, descriptor);
	for (let sample = 0; !first && sample < 30; sample++) {
		await page.waitForTimeout(100);
		first = await snapshot(page, descriptor);
	}
	if (!first) return null;
	const frames = [first];
	let current = first;
	const observe = async (accept: (frame: NonNullable<typeof first>) => boolean) => {
		let previous: Awaited<ReturnType<typeof snapshot>> = null;
		for (let sample = 0; sample < 30 && Date.now() < deadline; sample++) {
			const frame = await snapshot(page, descriptor);
			if (frame && accept(frame) && previous?.key === frame.key && JSON.stringify(previous.text) === JSON.stringify(frame.text) && JSON.stringify(previous.geometry) === JSON.stringify(frame.geometry)) return frame;
			previous = frame;
			await page.waitForTimeout(100);
		}
		return null;
	};
	const act = async (selector: string, before: NonNullable<typeof first>, accept: (frame: NonNullable<typeof first>) => boolean) => {
		for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
			const mutation = await page.locator(descriptor.selector).first().locator(descriptor.stage).evaluateHandle(stage => {
				let changed = false;
				const observer = new MutationObserver(() => { changed = true; });
				observer.observe(stage, { attributes: true, childList: true, characterData: true, subtree: true });
				return { observer, changed: () => changed };
			});
			await page.locator(descriptor.selector).first().locator(selector).click({ timeout: 2000 });
			await mutation.evaluate(state => new Promise<void>(resolve => {
				const started = performance.now();
				const check = () => state.changed() || performance.now() - started >= 800 ? resolve() : setTimeout(check, 20);
				check();
			}));
			await settle();
			const changed = await mutation.evaluate(state => { state.observer.disconnect(); return state.changed(); });
			await mutation.dispose();
			const immediate = await snapshot(page, descriptor);
			if (immediate && accept(immediate)) {
				const stable = await observe(accept);
				if (stable) return stable;
			} else if (immediate && immediate.key === before.key && !changed) {
				// The source can intentionally ignore controls while its own transition lock is held.
				continue;
			} else if (immediate) {
				// A different stable frame is a real but incorrect edge (for example, a
				// Previous control that actually advances); retries must not hide it.
				return null;
			} else {
				const stable = await observe(accept);
				if (stable) return stable;
			}
		}
		return null;
	};
	let complete = false;
	let continuityFailure = false;
	let failure: string | undefined;
	let pending: NonNullable<typeof first> | null = null;
	try {
		for (let count = 0; count < LIMIT && Date.now() < deadline; count++) {
			const before = current;
			const after = await act(descriptor.next, before, frame => frame.key !== before.key);
			if (!after || after.key === before.key) { failure = 'Next action did not produce a stable decoded successor'; break; }
			pending = after;
			current = after;
			pending = null;
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
		// Once Next has closed a cycle, walk it backwards and verify each inverse edge.
		if (complete) {
			for (let index = frames.length - 1; index >= 0; index--) {
				const expected = frames[index]!;
				const before = current;
				const restored = await act(descriptor.previous, before, frame => frame.key === expected.key);
				if (!restored) {
					failure = `Previous action did not restore ${expected.key}`;
					complete = false;
					break;
				}
				current = restored;
			}
		}
		if (complete && frames.every(frame => frame.slots && frame.slots.length >= 2)) {
			const continuous = frames.every((frame, index) => {
				const next = frames[(index + 1) % frames.length]!;
				return frame.slots!.length === next.slots!.length &&
					frame.slots!.slice(1).every((source, slot) => next.slots![slot] === source);
			});
			if (!continuous) {
				complete = false;
				continuityFailure = true;
				failure = 'Adjacent src-swap frames do not preserve overlapping slot continuity';
			}
		}
	} catch (error) {
		// A native actionability failure cannot erase already observed decoded
		// frames or certify their unverified inverse. Retain evidence, not a cycle.
		failure = String(error).slice(0, 500);
		if (pending && !frames.some(frame => frame.key === pending!.key) && Buffer.byteLength(JSON.stringify([...frames, pending])) <= BUDGET) frames.push(pending);
	}
	const sourceInitial = descriptor.order.indexOf(first.key);
	let ordered =
		complete &&
		descriptor.order.length === frames.length &&
		frames.every(
			(frame, index) => frame.key === descriptor.order[(sourceInitial + index) % frames.length],
		)
			? descriptor.order.map((key) => frames.find((frame) => frame.key === key)!)
			: frames;
	// Lazily materialized stages can still expose authored item indices. Use
	// them only when the complete observed successor cycle proves their order.
	if (complete && new Set(frames.map(frame => frame.ordinal)).size === frames.length && frames.every((frame, index) => Number.isInteger(frame.ordinal) && frame.ordinal! >= 0 && frame.ordinal! < frames.length && frames[(index + 1) % frames.length]!.ordinal === (frame.ordinal! + 1) % frames.length)) {
		ordered = [...frames].sort((a, b) => a.ordinal! - b.ordinal!);
	}
	return {
		...descriptor,
		initial: ordered.findIndex((frame) => frame.key === first.key),
		frames: ordered.map(({slot, geometry, ordinal, slots, ...frame}) => frame),
		coverage: complete ? 'complete' : 'partial',
		restoration: !continuityFailure && (await snapshot(page, descriptor))?.key === first.key ? 'verified' : 'unverified',
		autoplay: 'unmeasured',
		...(failure ? {failure} : {}),
	};
}

async function visibleGallerySurfaces(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const rendered = (image: HTMLImageElement) => {
			if (!image.complete || image.naturalWidth <= 1) return false;
			for (let node: Element | null = image; node; node = node.parentElement) {
				const style = getComputedStyle(node);
				if (style.visibility === 'hidden' || Number(style.opacity) < 0.1) return false;
			}
			const rect = image.getBoundingClientRect();
			const x = Math.max(0, rect.left) + Math.min(rect.width, innerWidth - Math.max(0, rect.left)) / 2;
			const y = Math.max(0, rect.top) + Math.min(rect.height, innerHeight - Math.max(0, rect.top)) / 2;
			return rect.width > 0 && rect.height > 0 && document.elementFromPoint(x, y) === image;
		};
		return Array.from(document.body.children).filter(el=>el.id &&
			(el.matches('dialog,[role="dialog"],[aria-modal="true"]') ||
				el.querySelector('[aria-label="Next slide"]') && el.querySelector('[aria-label*="Close" i]')) &&
			Array.from(el.querySelectorAll('img')).some(rendered)).map(el=>'#'+CSS.escape(el.id));
	});
}

/** Bind an observed cycle to the actual state at this viewport's serialization boundary. */
export async function alignCapturedGalleries(page: Page, states: CapturedDialogInteraction[]): Promise<void> {
	for (const state of states) {
		const gallery = state.gallery?.inline;
		if (!gallery || gallery.coverage !== 'complete') continue;
		for (let sample = 0; sample < 30; sample++) {
			const frame = await snapshot(page, gallery);
			const index = frame ? gallery.frames.findIndex(item => item.key === frame.key) : -1;
			if (frame && index >= 0) { gallery.initial = index; gallery.frames[index]!.text = frame.text; break; }
			if (sample === 29) gallery.restoration = 'unverified';
			await page.waitForTimeout(100);
		}
	}
}

/** Gallery evidence travels through interaction-states and its existing HTML/media export. */
export async function captureGalleries(page: Page): Promise<CapturedDialogInteraction[]> {
	await page.evaluate(() => {
		(globalThis as typeof globalThis & { __name?: (fn: unknown) => unknown }).__name ??= (fn) => fn;
	});
	const roots = await page.evaluate(() => {
		const controls = Array.from(document.querySelectorAll('button,[role="button"]'));
		const label = (element: Element) => (element.getAttribute('aria-label') || element.textContent || '').trim();
		const visible = (element: Element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
		const previous = controls.filter(element => visible(element) && /^previous (?:image|slide|photo|photograph|picture)$/i.test(label(element)));
		const next = controls.filter(element => visible(element) && /^next (?:image|slide|photo|photograph|picture)$/i.test(label(element)));
		const roots: string[] = [];
		for (const before of previous) {
			for (let scope = before.parentElement, depth = 0; scope && depth < 8; scope = scope.parentElement, depth++) {
				if (!next.some(after => scope!.contains(after)) || scope.querySelectorAll('img').length < 2) continue;
				if (!scope.id) scope.id = `dla-gallery-${roots.length}`;
				roots.push('#' + CSS.escape(scope.id));
				break;
			}
			if (roots.length >= 2) break;
		}
		return roots;
	});
	const states: CapturedDialogInteraction[] = [];
	for (const root of roots) {
		// Activation moves nested scrollports as well as the window. Keep actual
		// source node references so restoration cannot target replacement markup.
		const viewport = page.viewportSize();
		const scroll = await page.locator(root).evaluateHandle(element => {
			const ancestors: Array<{node: Element; x: number; y: number}> = [];
			for (let node: Element | null = element; node; node = node.parentElement) ancestors.push({node,x:node.scrollLeft,y:node.scrollTop});
			return {x:scrollX,y:scrollY,ancestors};
		});
		let state: CapturedDialogInteraction | undefined;
		try {
			await page.locator(root).scrollIntoViewIfNeeded();
			await page.locator(root).evaluate((element, width) => element.setAttribute('data-dla-gallery-capture-width', String(width)), page.viewportSize()?.width ?? 0);
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
			if (!inline) {
				states.push({status:'no-dialog',kind:'gallery',trigger:{selector:root,tag:'div',ariaHaspopup:'',dataBindings:{}},error:'No single decoded rendered initial image within the bounded stage readiness window'});
				continue;
			}
			state = {
				status: 'no-dialog',
				kind: 'gallery',
				trigger: { selector: root, tag: 'div', ariaHaspopup: '', dataBindings: {} },
				gallery: { inline },
			};
			states.push(state);
			// Incomplete cycles remain evidence, never a guessed portable interaction.
			if (inline.coverage !== 'complete' || inline.restoration !== 'verified') continue;
			const selected = await snapshot(page, inline);
			if (!selected) continue;
			const opener = root + inline.stage.replace(':scope', '') + ` > :nth-child(${selected.slot + 1}) img`;
			let before: string[] = [];
			try {
				await activateTrigger(page, opener, async () => { before = await visibleGallerySurfaces(page); });
			} catch (error) {
				state.error = String(error).slice(0, 500);
				continue;
			}
			let overlay: string | undefined;
			for (let sample = 0; !overlay && sample < 30; sample++) {
				await page.waitForTimeout(100);
				overlay = (await visibleGallerySurfaces(page)).find(selector=>!before.includes(selector));
			}
			if (!overlay) {
				state.error = 'No new visible lightbox after activating the decoded selected image';
				await page.keyboard.press('Escape');
				continue;
			}
			state.status = 'observed-incomplete';
			let lightbox: CapturedGallery | null = null;
			try {
				// The open, decoded image proves a surface, not that a preinitialized
				// stage has finished materializing. Use the existing bounded readiness
				// window before attempting the same strict directional cycle.
				let descriptor = await describe(page, overlay);
				for (let sample = 0; !descriptor && sample < 30; sample++) {
					await page.waitForTimeout(100);
					descriptor = await describe(page, overlay);
				}
				lightbox = await collect(page, descriptor);
				if (!descriptor) state.error = 'Observed decoded lightbox has no bounded stage with labelled directional controls';
				else if (!lightbox) state.error = 'Observed lightbox has no single decoded initial frame within the bounded readiness window';
			} catch (error) {
				state.error = String(error).slice(0, 500);
			}
			if (lightbox) {
				state.gallery!.lightbox = lightbox;
				if (lightbox.failure) state.error = lightbox.failure;
			}
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
			if (await close.count()) {
				await close.click({ timeout: 2000 }).catch((error) => {
					state!.error = String(error).slice(0, 500);
				});
			} else {
				// Touch viewers can expose neither directional buttons nor a close
				// icon. Escape is an existing native dialog action; closure still has
				// to be observed, and absent directional proof stays incomplete.
				await page.keyboard.press('Escape');
			}
			for (let sample = 0; sample < 30; sample++) {
				await page.waitForTimeout(100);
				state.gallery!.closed = !(await visibleGallerySurfaces(page)).includes(overlay);
				if (state.gallery!.closed) break;
			}
			if (
				lightbox?.coverage === 'complete' &&
				lightbox.restoration === 'verified' &&
				state.gallery!.closed
			) {
				const selection = inline.frames.map(frame => lightbox.frames.findIndex(full => full.key === (frame.fullImage || frame.key)));
				if (selection.every(index => index >= 0) && new Set(selection).size === lightbox.frames.length) {
					state.gallery!.selection = selection;
					state.status = 'captured';
				} else state.error = 'Observed inline images do not identify the complete decoded lightbox cycle';
			}
		} finally {
			try {
				await withEvaluateTimeout(scroll.evaluate(async pose => {
					for (const {node,x,y} of pose.ancestors) if (node.isConnected) node.scrollTo({left:x,top:y,behavior:'instant'});
					window.scrollTo({left:pose.x,top:pose.y,behavior:'instant'});
					await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
				}), 5_000);
				await settleDocument(page, 'gallery-restore', { quietMs: 0, timeoutMs: 2_000, animations: true });
				const restored = await scroll.evaluate(pose => scrollX === pose.x && scrollY === pose.y && pose.ancestors.every(({node,x,y}) => node.isConnected && node.scrollLeft === x && node.scrollTop === y));
				if (state?.gallery) {
					state.gallery.viewportRestoration = restored && JSON.stringify(page.viewportSize()) === JSON.stringify(viewport) ? 'verified' : 'unverified';
					if (state.gallery.viewportRestoration === 'unverified' && state.status === 'captured') {
						state.status = 'observed-incomplete';
						state.error = 'Source gallery viewport/scroll restoration is unverified';
					}
				}
			} catch (error) {
				if (state?.gallery) {
					state.gallery.viewportRestoration = 'unverified';
					if (state.status === 'captured') state.status = 'observed-incomplete';
					state.error = `Source gallery viewport/scroll restoration failed: ${String(error).slice(0, 400)}`;
				}
			} finally { await scroll.dispose(); }
		}
	}
	return states;
}
