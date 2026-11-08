import type { Page } from 'playwright';
import { snapshotCarousels, exploreCarousel, type Slideshow } from './carousel-components.js';
import { captureControlledDisclosure, type CapturedDialogInteraction, type InteractionStatesReport } from './interaction-capture.js';

/** A route's stateful surfaces, not an inventory of individual trigger clicks. */
export interface CapturedComponent {
	selector: string;
	/** Layout in which the trigger rendered and its states were explored. */
	viewport?: { id?: string; width: number; height: number };
	function?: 'slideshow';
	slideshow?: Slideshow;
	collection?: import('./collection-capture.js').CollectionEvidence;
	kind: 'collection' | 'tabs' | 'disclosure' | 'dialog' | 'listbox' | 'carousel' | 'menu' | 'filter' | 'choice-group' | 'unsupported';
	initial: string;
	states: Array<{ id: string; html: string; evidence?: CapturedDialogInteraction }>;
	transitions: Array<{ from: string; to: string; trigger: { selector: string; action: 'click' | 'keyboard' | 'swipe' } }>;
	status: 'captured' | 'unsupported' | 'partial';
	reason?: string;
}

export interface ComponentBaseline {
	components: CapturedComponent[];
	controls: Array<{ component: number; selector: string; state: string }>;
	/** All descendants are excluded from the older shape-based probes. */
	skip?: string;
}

/** Read only. Called before any component exploration, on the settled route. */
export async function snapshotComponents(page: Page): Promise<ComponentBaseline> {
	const carousels = await snapshotCarousels(page);
	const baseline = await page.evaluate((carousels) => {
		const selector = (element: Element): string => {
			if (element.id && document.querySelectorAll('#' + CSS.escape(element.id)).length === 1) return '#' + CSS.escape(element.id);
			const parts: string[] = [];
			for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
				const siblings = Array.from(node.parentElement?.children ?? []).filter(sibling => sibling.tagName === node!.tagName);
				parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
			}
			return 'body > ' + parts.join(' > ');
		};
		const components: CapturedComponent[] = carousels;
		const controls: ComponentBaseline['controls'] = [];
		const roots: string[] = carousels.map(node => node.selector);
		for (const root of Array.from(document.querySelectorAll('[role="tablist"],details,[aria-roledescription="carousel"],[aria-expanded][aria-controls]:not([role="tab"]),[aria-haspopup]')).slice(0, 64)) {
			const target = document.getElementById(root.getAttribute('aria-controls') ?? '');
			if (carousels.some(node => document.querySelector(node.selector)?.contains(root))) continue;
			const surface = target?.matches('[role="dialog"],[role="listbox"],[role="menu"],dialog') ? target : target?.querySelector('[role="dialog"],[role="listbox"],[role="menu"],dialog');
			const role = surface?.getAttribute('role') ?? (surface?.tagName === 'DIALOG' ? 'dialog' : root.getAttribute('aria-haspopup'));
			const kind: CapturedComponent['kind'] = root.matches('[role="tablist"]') ? 'tabs' : root.matches('details') ? 'disclosure' : root.matches('[aria-roledescription="carousel"]') ? 'carousel' : role === 'dialog' || role === 'listbox' || role === 'menu' ? role : !role && target && (!root.closest('header,nav,footer,[role="navigation"],[role="banner"]') || !target.querySelector('a[href]')) ? 'disclosure' : 'unsupported';
			const rootSelector = selector(root);
			const dedicated = kind === 'tabs' || kind === 'disclosure' || kind === 'carousel';
			const members = kind === 'disclosure' && !root.matches('details') ? [root as HTMLElement] : Array.from(root.querySelectorAll<HTMLElement>(kind === 'tabs' ? '[role="tab"]' : kind === 'disclosure' ? ':scope > summary' : 'button,[role="button"]'));
			const selected = kind === 'tabs' ? members.findIndex(member => member.getAttribute('aria-selected') === 'true') : -1;
			const activeSlide = kind === 'carousel' ? Array.from(root.querySelectorAll('[aria-roledescription="slide"]')).findIndex(slide => !slide.hasAttribute('hidden') && getComputedStyle(slide).display !== 'none') : -1;
			const initial = kind === 'tabs' ? `tab-${Math.max(0, selected)}` : kind === 'disclosure' ? (root.hasAttribute('open') || root.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed') : kind === 'carousel' ? `slide-${Math.max(0, activeSlide)}` : root.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed';
			const component = components.length;
			// Tabs own their panels even when the runtime has not mounted them yet.
			let owner = root;
			if (kind === 'tabs') {
				const targets = members.map(member => member.getAttribute('aria-controls')).filter(Boolean);
				while (owner.parentElement && owner !== document.body && targets.some(id => { const panel = document.getElementById(id!); return panel && !owner.contains(panel); })) owner = owner.parentElement;
			}
			const initialPanel = kind === 'tabs' ? document.getElementById(members[Math.max(0, selected)]?.getAttribute('aria-controls') ?? '') : undefined;
			components.push({ selector: rootSelector, kind, initial, states: [{ id: initial, html: (initialPanel?.outerHTML ?? owner.outerHTML + (target && !owner.contains(target) ? target.outerHTML : '')).slice(0, 512 * 1024) }], transitions: [], status: kind === 'unsupported' ? 'unsupported' : 'captured' });
			if (!dedicated) continue;
			roots.push(rootSelector);
			members.slice(0, 24).forEach((member, index) => controls.push({ component, selector: selector(member), state: kind === 'tabs' ? `tab-${index}` : kind === 'disclosure' ? (initial === 'open' ? 'closed' : 'open') : '' }));
		}
		return { components, controls, ...(roots.length ? { skip: roots.flatMap(root => [root, root + ' *']).join(',') } : {}) };
	}, carousels);
	return baseline;
}

/** Exploration owns only component states. It never returns replacement route HTML. */
export async function exploreComponents(page: Page, baseline: ComponentBaseline, skip?: string, viewports: Array<{ id?: string; width: number; height: number }> = []): Promise<CapturedComponent[]> {
	const components = structuredClone(baseline.components);
	const deadline = Date.now() + 30_000;
	const originalViewport = page.viewportSize();
	const candidates = viewports.length ? viewports : originalViewport ? [originalViewport] : [];
	try {
	for (const [index, component] of components.entries()) {
		let current = component.initial;
		const controls = baseline.controls.filter(control => control.component === index);
		if (!controls.length && !component.slideshow) continue;
		if (skip && await page.locator(component.selector).first().evaluate((root, excluded) => root.matches(excluded), skip).catch(() => true)) {
			component.status = 'unsupported'; component.reason = 'interaction probe region excluded'; continue;
		}
		// Visibility, unlike click actionability, is a layout fact. Do not spend a
		// click timeout on a control hidden by this profile's media queries.
		let rendered = false;
		for (const viewport of candidates) {
			if (Date.now() > deadline) break;
			const size = page.viewportSize();
			if (size?.width !== viewport.width || size?.height !== viewport.height) await page.setViewportSize({ width: viewport.width, height: viewport.height });
			rendered = await page.locator(controls[0]?.selector ?? component.selector).first().evaluate(element => {
				const box = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
			}).catch(() => false);
			if (rendered) { component.viewport = { ...viewport }; break; }
		}
		if (!rendered) {
			component.status = 'partial';
			component.reason = Date.now() > deadline ? 'component exploration limit' : 'trigger not rendered at captured viewports';
			continue;
		}
		if (component.slideshow) {
			try { await exploreCarousel(page, component); }
			catch { component.status = 'partial'; component.reason = 'carousel exploration failed'; }
			continue;
		}
		if (component.kind === 'disclosure' && component.initial === 'closed' && await page.locator(component.selector).getAttribute('aria-controls')) {
			try {
				const { evidence, restored, dismissal } = await captureControlledDisclosure(page, component.selector);
				if (evidence?.dialog) {
					const html = await page.locator(component.selector).evaluate((root, panelHtml) => {
						const clone = root.cloneNode(true) as Element;
						clone.setAttribute('aria-expanded', 'true');
						return clone.outerHTML + panelHtml;
					}, evidence.dialog.html);
					component.states.push({ id: 'open', html, evidence });
					component.transitions.push({ from: 'closed', to: 'open', trigger: { selector: component.selector, action: 'click' } });
					if (restored && dismissal) component.transitions.push({ from: 'open', to: 'closed', trigger: dismissal });
				}
				if (!evidence || !restored) { component.status = 'partial'; component.reason = !evidence ? 'activation did not reveal a classified state' : 'disclosure dismissal did not restore baseline'; }
			} catch { component.status = 'partial'; component.reason = 'disclosure exploration failed'; }
			continue;
		}
		// Legacy caches without slideshow observations retain bounded exploration.
		const restore = controls.find(control => control.state === component.initial);
		const drives = component.kind === 'carousel' ? Array.from({ length: 24 }, () => controls.find(control => /next|forward/i.test(control.selector)) ?? controls.at(-1)).filter(Boolean) : component.kind === 'tabs' ? [...controls, ...(restore ? [restore] : [])] : [...controls, ...controls];
		for (const control of drives) {
			if (!control || Date.now() > deadline) { component.status = 'partial'; component.reason = 'component exploration limit'; break; }
			if (component.kind === 'tabs' && control.state === current) continue;
			try {
				await page.locator(control.selector).click({ timeout: 1_000 });
				await page.waitForTimeout(150);
				if (component.kind === 'tabs') await page.waitForFunction(selector => {
					const tab = document.querySelector(selector)?.querySelector('[role="tab"][aria-selected="true"]');
					return document.getElementById(tab?.getAttribute('aria-controls') ?? '')?.getAttribute('role') === 'tabpanel';
				}, component.selector, { timeout: 2_000 }).catch(() => undefined);
				const observed = await page.evaluate(({ selector, kind, state }) => {
					const root = document.querySelector(selector);
					if (!root) return null;
					if (kind === 'tabs') {
						const tab = root.querySelector('[role="tab"][aria-selected="true"]');
						const panel = document.getElementById(tab?.getAttribute('aria-controls') ?? '');
						return panel?.getAttribute('role') === 'tabpanel' ? { id: state, html: panel.outerHTML.slice(0, 512 * 1024) } : null;
					}
					if (kind === 'disclosure') {
						const target = document.getElementById(root.getAttribute('aria-controls') ?? '');
						return { id: root.hasAttribute('open') || root.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed', html: (root.outerHTML + (target ? target.outerHTML : '')).slice(0, 512 * 1024) };
					}
					const slides = Array.from(root.querySelectorAll('[aria-roledescription="slide"]'));
					const active = slides.findIndex(slide => !slide.hasAttribute('hidden') && getComputedStyle(slide).display !== 'none');
					return active >= 0 ? { id: `slide-${active}`, html: root.outerHTML.slice(0, 512 * 1024) } : null;
				}, { selector: component.selector, kind: component.kind, state: control.state });
				if (!observed) { component.status = 'unsupported'; component.reason = 'activation did not reveal a classified state'; break; }
				if (!component.states.some(state => state.id === observed.id)) component.states.push(observed);
				component.transitions.push({ from: current, to: observed.id, trigger: { selector: control.selector, action: 'click' } });
				current = observed.id;
				if (component.kind === 'carousel' && current === component.initial) break;
			} catch {
				component.status = 'partial'; component.reason = 'trigger activation failed'; break;
			}
		}
	}
	return components;
	} finally {
		if (originalViewport) {
			const size = page.viewportSize();
			if (size?.width !== originalViewport.width || size?.height !== originalViewport.height) await page.setViewportSize(originalViewport);
		}
	}
}

/** Project the role-classified popup probe into the same component contract. */
export function popupComponents(states: CapturedDialogInteraction[], initial: CapturedComponent[] = []): CapturedComponent[] {
	const result = [...initial];
	for (const state of states) {
		if (state.kind && state.kind !== 'dialog') continue;
		if (state.status === 'no-dialog' && !state.dialog) continue;
		const role = state.dialog?.role ?? (state.dialog?.tag === 'dialog' || state.trigger.ariaHaspopup === 'dialog' ? 'dialog' : undefined);
		const known = result.find(component => component.selector === state.trigger.selector || state.trigger.id && component.selector === '#' + state.trigger.id);
		const kind = role === 'dialog' || role === 'listbox' || role === 'menu' ? role : known?.kind === 'menu' ? 'menu' : 'unsupported';
		const selector = state.trigger.selector;
		const node = known ?? {
			selector, kind, initial: 'closed', states: [{ id: 'closed', html: '' }], transitions: [], status: kind === 'unsupported' ? 'unsupported' : 'captured',
		} satisfies CapturedComponent;
		if (!result.includes(node)) result.push(node);
		if (kind === 'unsupported') { node.status = 'unsupported'; node.reason = 'surface has no supported semantic role'; continue; }
		node.kind = kind;
		node.status = 'captured';
		if (state.status !== 'captured') { node.status = 'partial'; node.reason = state.error ?? state.status; continue; }
		if (node.initial !== 'open' && !node.states.some(item => item.id === 'open')) node.states.push({ id: 'open', html: state.dialog?.html ?? '', evidence: state });
		else if (node.initial === 'open') node.states[0].evidence = state;
		if (!node.transitions.some(edge => edge.to === 'open')) node.transitions.push({ from: 'closed', to: 'open', trigger: { selector, action: 'click' } });
	}
	return result;
}

export function componentReplayStates(components: CapturedComponent[] = []): CapturedDialogInteraction[] {
	return components.flatMap(component => component.status === 'unsupported' ? [] : component.states.flatMap(state => state.evidence ? [state.evidence] : []));
}

/** Consume older capture caches, but emit only the component-owned inventory. */
export function routeComponents(report: InteractionStatesReport): CapturedComponent[] {
	const result = popupComponents(report.states, structuredClone(report.components ?? []));
	for (const evidence of report.states) {
		if (!evidence.kind || evidence.kind === 'dialog') continue;
		const selector = evidence.gallery?.inline.selector ?? evidence.set?.selector ?? evidence.choiceGroup?.group.selector ?? evidence.trigger.selector;
		// Each viewport's gallery frames are independent replay evidence.
		let component = result.find(node => node.selector === selector && (!evidence.gallery || !node.states.some(state =>
			state.evidence?.gallery && state.evidence.gallery.inline.viewport.width !== evidence.gallery!.inline.viewport.width
		)));
		if (!component) {
			const kind = evidence.kind === 'gallery' ? 'carousel' : evidence.kind === 'disclosure' ? 'disclosure' : evidence.kind === 'selectable-set' && evidence.trigger.role === 'tab' ? 'tabs' : evidence.kind === 'typed-search' ? 'filter' : evidence.kind === 'choice-group' ? 'choice-group' : 'unsupported';
			const initial = evidence.gallery ? `slide-${evidence.gallery.inline.initial}` : 'initial';
			component = { selector, kind, initial, states: [{ id: initial, html: '' }], transitions: [], status: kind === 'unsupported' ? 'unsupported' : evidence.status === 'captured' ? 'captured' : 'partial' };
			result.push(component);
		}
		if (component.status === 'unsupported') { component.reason = 'shape has no classified component role'; continue; }
		if (evidence.gallery && component.slideshow) continue;
		if (evidence.gallery) {
			const gallery = evidence.gallery.inline;
			component.states = gallery.frames.map((frame, index) => ({ id: `slide-${index}`, html: frame.html, ...(index === gallery.initial ? { evidence } : {}) }));
			component.status = gallery.coverage === 'complete' ? 'captured' : 'partial';
			component.transitions = gallery.frames.flatMap((_frame, index) => [
				{ from: `slide-${index}`, to: `slide-${(index + 1) % gallery.frames.length}`, trigger: { selector: gallery.selector + ' ' + gallery.next.replace(/^:scope\s*/, ''), action: 'click' as const } },
				{ from: `slide-${index}`, to: `slide-${(index + gallery.frames.length - 1) % gallery.frames.length}`, trigger: { selector: gallery.selector + ' ' + gallery.previous.replace(/^:scope\s*/, ''), action: 'click' as const } },
			]);
		} else {
			const id = evidence.set ? `member-${evidence.trigger.id ?? evidence.set.index}` : 'open';
			if (!component.states.some(state => state.id === id)) component.states.push({ id, html: evidence.dialog?.html ?? '', evidence });
			component.transitions.push({ from: component.initial, to: id, trigger: { selector: evidence.trigger.selector, action: 'click' } });
		}
	}
	for (const dialog of report.initialDialogs ?? []) {
		const existing = result.find(node => node.selector === dialog.dialog.selector || node.states.some(state => state.evidence?.dialog?.selector === dialog.dialog.selector));
		if (existing) {
			existing.initial = 'open';
			const open = existing.states.find(state => state.id === 'open');
			if (open) open.html = dialog.dialog.html;
			else existing.states.unshift({ id: 'open', html: dialog.dialog.html });
			if (dialog.dismissal) existing.transitions.push({ from: 'open', to: 'closed', trigger: { selector: dialog.dismissal.control.selector, action: 'click' } });
			continue;
		}
		result.push({ selector: dialog.dialog.selector, kind: 'dialog', initial: 'open', states: [{ id: 'open', html: dialog.dialog.html }, ...(dialog.dismissal ? [{ id: 'closed', html: '' }] : [])], transitions: dialog.dismissal ? [{ from: 'open', to: 'closed', trigger: { selector: dialog.dismissal.control.selector, action: 'click' } }] : [], status: dialog.status === 'captured' ? 'captured' : 'partial' });
	}
	return result;
}
