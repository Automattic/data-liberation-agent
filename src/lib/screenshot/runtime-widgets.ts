import type { BrowserContext, Page } from 'playwright';
import { isFirstParty } from './first-party.js';

/** Runs before source scripts. Ownership is private: no attributes leak into HTML.
 * Only newly created elements qualify, never authored nodes moved by a script.
 * currentScript covers synchronous execution; stacks retain the executing script
 * URL in timer/event callbacks without replacing the page's scheduling APIs.
 */
function observeRuntimeWidgets(): void {
	const owners = new WeakMap<Element, string>();
	const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return url; } };
	// An overlay island renders nothing in flow: either the root itself is
	// fixed, or it is an empty in-flow box whose rendered content is fixed.
	const isOverlayIsland = (root: Element): boolean => {
		if (getComputedStyle(root).position === 'fixed') return true;
		const box = root.getBoundingClientRect();
		if (box.width > 0 && box.height > 0) return false;
		return [...root.querySelectorAll('*')].some(child => getComputedStyle(child).position === 'fixed');
	};
	const roots = new Map<Element, string>();
	const scriptUrl = (): string | undefined => {
		const current = document.currentScript;
		if (current instanceof HTMLScriptElement) return current.src || document.URL;
		const stack = new Error().stack ?? '';
		return stack.match(/https?:\/\/[^\s)]+?(?=:\d+:\d+(?:\)|\s|$))/)?.[0];
	};
	const create = Document.prototype.createElement;
	Document.prototype.createElement = function (...args: Parameters<typeof create>) {
		const element = create.apply(this, args);
		const source = scriptUrl();
		if (source) owners.set(element, source);
		return element;
	};
	const remember = (node: Node): void => {
		if (!(node instanceof Element) || node.parentElement !== document.body) return;
		const source = owners.get(node);
		const inserter = scriptUrl();
		if (source && inserter && originOf(source) === originOf(inserter)) roots.set(node, source);
	};
	const appendChild = Node.prototype.appendChild;
	Node.prototype.appendChild = function <T extends Node>(node: T): T {
		const result = appendChild.call(this, node) as T;
		remember(node);
		return result;
	};
	const insertBefore = Node.prototype.insertBefore;
	Node.prototype.insertBefore = function <T extends Node>(node: T, child: Node | null): T {
		const result = insertBefore.call(this, node, child) as T;
		remember(node);
		return result;
	};
	const append = Element.prototype.append;
	Element.prototype.append = function (...nodes: (Node | string)[]): void {
		append.apply(this, nodes);
		for (const node of nodes) if (node instanceof Node) remember(node);
	};
	const prepend = Element.prototype.prepend;
	Element.prototype.prepend = function (...nodes: (Node | string)[]): void {
		prepend.apply(this, nodes);
		for (const node of nodes) if (node instanceof Node) remember(node);
	};
	const insertAdjacentElement = Element.prototype.insertAdjacentElement;
	Element.prototype.insertAdjacentElement = function (position: InsertPosition, element: Element): Element | null {
		const result = insertAdjacentElement.call(this, position, element);
		if (result) remember(result);
		return result;
	};
	const insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
	Element.prototype.insertAdjacentHTML = function (position: InsertPosition, text: string): void {
		// Native HTML parsing bypasses createElement. Bound the inserted sibling
		// range so existing children (including authored markup) gain no owner.
		const where = position.toLowerCase();
		const parent = where === 'beforebegin' || where === 'afterend' ? this.parentElement : this;
		const previous = where === 'beforebegin' ? this.previousSibling : where === 'afterend' ? this : where === 'afterbegin' ? null : this.lastChild;
		const next = where === 'beforebegin' ? this : where === 'afterend' ? this.nextSibling : where === 'afterbegin' ? this.firstChild : null;
		const source = scriptUrl();
		insertAdjacentHTML.call(this, position, text);
		if (parent !== document.body || !source) return;
		for (let node = previous ? previous.nextSibling : parent.firstChild; node && node !== next; node = node.nextSibling) {
			if (node instanceof Element && node.parentElement === document.body) {
				owners.set(node, source);
				roots.set(node, source);
			}
		}
	};
	const state = {
		origins: () => [...new Set([...roots.values()].map(source => new URL(source).origin))],
		remove: (origins: string[]) => {
			const removed: { root: string; origin: string }[] = [];
			for (const [root, source] of roots) {
				const origin = new URL(source).origin;
				if (!origins.includes(origin) || root.parentElement !== document.body) continue;
				// A runtime script can render legitimate in-flow content. Only a
				// detached overlay island is excluded, not arbitrary third-party DOM.
				if (!isOverlayIsland(root)) continue;
				removed.push({ root: root.tagName.toLowerCase() + (root.id ? `#${root.id}` : '') + [...root.classList].map(name => `.${name}`).join(''), origin });
				root.remove();
				roots.delete(root);
			}
			return removed;
		},
	};
	Object.defineProperty(window, '__captureRuntimeWidgets', { value: state, configurable: true });
}

type WidgetWindow = Window & { __captureRuntimeWidgets?: {
	origins(): string[];
	remove(origins: string[]): { root: string; origin: string }[];
} };

export async function installRuntimeWidgetAttribution(context: BrowserContext): Promise<void> {
	await context.addInitScript(observeRuntimeWidgets);
}

/** Best-effort: a page that cannot answer keeps its DOM and capture continues. */
export async function removeRuntimeWidgets(page: Page): Promise<{ code: string; reason: string }[]> {
	try {
		const origins: unknown = await page.evaluate(() => (window as WidgetWindow).__captureRuntimeWidgets?.origins() ?? []);
		if (!Array.isArray(origins)) return [];
		const thirdParty = origins.filter((origin): origin is string => typeof origin === 'string' && !isFirstParty(origin, page.url()));
		if (!thirdParty.length) return [];
		const removed: unknown = await page.evaluate(origins => (window as WidgetWindow).__captureRuntimeWidgets?.remove(origins) ?? [], thirdParty);
		return Array.isArray(removed) ? diagnostics(removed) : [];
	} catch {
		return [];
	}
}

function diagnostics(removed: { root: string; origin: string }[]): { code: string; reason: string }[] {
	return removed.map(({ root, origin }) => ({ code: 'third_party_runtime_widget_removed', reason: `removed ${root}; runtime script origin ${origin}` }));
}
