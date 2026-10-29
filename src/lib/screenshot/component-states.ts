import type { Page } from 'playwright';
import type { CapturedDialogInteraction, InteractionStatesReport } from './interaction-capture.js';

/** A route's stateful surfaces, not an inventory of individual trigger clicks. */
export interface CapturedComponent {
	selector: string;
	kind: 'tabs' | 'disclosure' | 'dialog' | 'listbox' | 'carousel' | 'menu' | 'filter' | 'choice-group' | 'unsupported';
	initial: string;
	states: Array<{ id: string; html: string; evidence?: CapturedDialogInteraction }>;
	transitions: Array<{ from: string; to: string; trigger: { selector: string; action: 'click' } }>;
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
	return page.evaluate(() => {
		const selector = (element: Element): string => {
			if (element.id && document.querySelectorAll('#' + CSS.escape(element.id)).length === 1) return '#' + CSS.escape(element.id);
			const parts: string[] = [];
			for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
				const siblings = Array.from(node.parentElement?.children ?? []).filter(sibling => sibling.tagName === node!.tagName);
				parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
			}
			return 'body > ' + parts.join(' > ');
		};
		const components: CapturedComponent[] = [];
		const controls: ComponentBaseline['controls'] = [];
		const roots: string[] = [];
		for (const root of Array.from(document.querySelectorAll('[role="tablist"],details,[aria-roledescription="carousel"],[aria-expanded][aria-controls]:not([role="tab"]),[aria-haspopup]')).slice(0, 64)) {
			const target = document.getElementById(root.getAttribute('aria-controls') ?? '');
			const surface = target?.matches('[role="dialog"],[role="listbox"],[role="menu"],dialog') ? target : target?.querySelector('[role="dialog"],[role="listbox"],[role="menu"],dialog');
			const role = surface?.getAttribute('role') ?? (surface?.tagName === 'DIALOG' ? 'dialog' : root.getAttribute('aria-haspopup'));
			const kind: CapturedComponent['kind'] = root.matches('[role="tablist"]') ? 'tabs' : root.matches('details') ? 'disclosure' : root.matches('[aria-roledescription="carousel"]') ? 'carousel' : role === 'dialog' || role === 'listbox' || role === 'menu' ? role : !role && target && !root.closest('header,nav,footer,[role="navigation"],[role="banner"]') ? 'disclosure' : 'unsupported';
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
	});
}

/** Exploration owns only component states. It never returns replacement route HTML. */
export async function exploreComponents(page: Page, baseline: ComponentBaseline, skip?: string): Promise<CapturedComponent[]> {
	const components = structuredClone(baseline.components);
	const deadline = Date.now() + 30_000;
	for (const [index, component] of components.entries()) {
		let current = component.initial;
		const controls = baseline.controls.filter(control => control.component === index);
		if (!controls.length) continue;
		if (skip && await page.locator(component.selector).first().evaluate((root, excluded) => root.matches(excluded), skip).catch(() => true)) {
			component.status = 'unsupported'; component.reason = 'interaction probe region excluded'; continue;
		}
		// Directional carousels are driven until the initial state repeats, not just once per button.
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
		let component = result.find(node => node.selector === selector);
		if (!component) {
			const kind = evidence.kind === 'gallery' ? 'carousel' : evidence.kind === 'disclosure' ? 'disclosure' : evidence.kind === 'selectable-set' && evidence.trigger.role === 'tab' ? 'tabs' : evidence.kind === 'typed-search' ? 'filter' : evidence.kind === 'choice-group' ? 'choice-group' : 'unsupported';
			const initial = evidence.gallery ? `slide-${evidence.gallery.inline.initial}` : 'initial';
			component = { selector, kind, initial, states: [{ id: initial, html: '' }], transitions: [], status: kind === 'unsupported' ? 'unsupported' : evidence.status === 'captured' ? 'captured' : 'partial' };
			result.push(component);
		}
		if (component.status === 'unsupported') { component.reason = 'shape has no classified component role'; continue; }
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
