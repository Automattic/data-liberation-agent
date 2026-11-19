import type { BrowserContext, Page } from 'playwright';

/** Runs before source scripts. Ownership is private: the only attributes it writes
 * are the inert runtime-owner stamps `mark` puts on cross-origin in-flow embeds.
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
	// A page can wrap the hooked API with its own script. Its frame is named for
	// the API (`HTMLDocument.value [as createElement] (...)`, `.createElement (`)
	// or for the wrapper the receiver now resolves (`HTMLDocument.value (`), so
	// skip those and attribute the next script frame, the actual caller.
	const scriptUrl = (receiver: unknown, api: string): string | undefined => {
		const current = document.currentScript;
		if (current instanceof HTMLScriptElement) return current.src || document.URL;
		const names = [api];
		try {
			const wrapper: unknown = (receiver as Record<string, unknown>)[api];
			if (typeof wrapper === 'function' && /^[\w$]+$/.test(wrapper.name)) names.push(wrapper.name);
		} catch { /* An exotic receiver contributes no wrapper name. */ }
		const implementsApi = new RegExp(`(?:\\.|\\[as |at )(?:${names.join('|').replace(/\$/g, '\\$')})\\]? \\(`);
		for (const frame of (new Error().stack ?? '').split('\n').slice(1)) {
			if (implementsApi.test(frame)) continue;
			const url = frame.match(/https?:\/\/[^\s)]+?(?=:\d+:\d+(?:\)|\s|$))/)?.[0];
			if (url) return url;
		}
		return undefined;
	};
	const create = Document.prototype.createElement;
	Document.prototype.createElement = function (...args: Parameters<typeof create>) {
		const element = create.apply(this, args);
		const source = scriptUrl(this, 'createElement');
		if (source) owners.set(element, source);
		return element;
	};
	// In-flow roots: a script-created element inserted inside an authored
	// container rather than as a `<body>` child. Only the outermost element of
	// an owned subtree is kept; children built into it are not roots.
	const inFlow = new Map<Element, string>();
	const ownedBySameOrigin = (element: Element | null, source: string): boolean => {
		const owner = element ? owners.get(element) : undefined;
		return owner !== undefined && originOf(owner) === originOf(source);
	};
	const remember = (receiver: Node, node: Node, api: string): void => {
		if (!(node instanceof Element) || !node.parentElement) return;
		const source = owners.get(node);
		if (!source) return;
		const atBody = node.parentElement === document.body;
		// Checked before reading a stack: most insertions build an owned subtree.
		if (!atBody && ownedBySameOrigin(node.parentElement, source)) return;
		const inserter = scriptUrl(receiver, api);
		if (!inserter || originOf(source) !== originOf(inserter)) return;
		if (atBody) roots.set(node, source);
		else inFlow.set(node, source);
	};
	const appendChild = Node.prototype.appendChild;
	Node.prototype.appendChild = function <T extends Node>(node: T): T {
		const result = appendChild.call(this, node) as T;
		remember(this, node, 'appendChild');
		return result;
	};
	const insertBefore = Node.prototype.insertBefore;
	Node.prototype.insertBefore = function <T extends Node>(node: T, child: Node | null): T {
		const result = insertBefore.call(this, node, child) as T;
		remember(this, node, 'insertBefore');
		return result;
	};
	const append = Element.prototype.append;
	Element.prototype.append = function (...nodes: (Node | string)[]): void {
		append.apply(this, nodes);
		for (const node of nodes) if (node instanceof Node) remember(this, node, 'append');
	};
	const prepend = Element.prototype.prepend;
	Element.prototype.prepend = function (...nodes: (Node | string)[]): void {
		prepend.apply(this, nodes);
		for (const node of nodes) if (node instanceof Node) remember(this, node, 'prepend');
	};
	const insertAdjacentElement = Element.prototype.insertAdjacentElement;
	Element.prototype.insertAdjacentElement = function (position: InsertPosition, element: Element): Element | null {
		const result = insertAdjacentElement.call(this, position, element);
		if (result) remember(this, result, 'insertAdjacentElement');
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
		const source = scriptUrl(this, 'insertAdjacentHTML');
		insertAdjacentHTML.call(this, position, text);
		if (!parent || !source) return;
		const nested = parent !== document.body && ownedBySameOrigin(parent, source);
		for (let node = previous ? previous.nextSibling : parent.firstChild; node && node !== next; node = node.nextSibling) {
			if (!(node instanceof Element) || node.parentElement !== parent) continue;
			owners.set(node, source);
			if (parent === document.body) roots.set(node, source);
			else if (!nested) inFlow.set(node, source);
		}
	};
	// The declarative embed: a `<script src>` inside an authored container that
	// holds the root, below `<body>`. A script of the creating origin wins, then
	// any other cross-origin script there. A root with no such container is a
	// page-wide runtime, not an embed, and is never marked.
	const embedScript = (root: Element, source: string, pageOrigin: string): HTMLScriptElement | undefined => {
		for (let container = root.parentElement; container && container !== document.body && container !== document.documentElement; container = container.parentElement) {
			const scripts = [...container.querySelectorAll('script[src]')]
				.filter((script): script is HTMLScriptElement => script instanceof HTMLScriptElement && !root.contains(script) && /^https?:$/.test(new URL(script.src, document.baseURI).protocol));
			const script = scripts.find(candidate => originOf(candidate.src) === originOf(source))
				?? scripts.find(candidate => originOf(candidate.src) !== pageOrigin);
			if (script) return script;
		}
		return undefined;
	};
	const MAX_DATA_ATTRIBUTES = 32;
	const MAX_DATA_VALUE = 1024;
	const state = {
		origins: () => [...new Set([...roots.values()].map(source => new URL(source).origin))],
		remove: (origins: string[]) => {
			const removed: { root: string; origin: string }[] = [];
			for (const [root, source] of roots) {
				const origin = new URL(source).origin;
				if (!origins.includes(origin) || root.parentElement !== document.body) continue;
				// A runtime script can render legitimate in-flow content. Only a
				// detached overlay island is excluded, not arbitrary cross-origin DOM.
				if (!isOverlayIsland(root)) continue;
				removed.push({ root: root.tagName.toLowerCase() + (root.id ? `#${root.id}` : '') + [...root.classList].map(name => `.${name}`).join(''), origin });
				root.remove();
				roots.delete(root);
			}
			return removed;
		},
		// Marks in-flow interactive roots a cross-origin script rendered inside an
		// authored container. The marker carries the embed script's origin, path
		// and declarative `data-*` attributes as inert data; export turns it into
		// the region's stable marker and source evidence.
		mark: (pageOrigin: string) => {
			let marked = 0;
			for (const [root, source] of inFlow) {
				if (!root.isConnected) { inFlow.delete(root); continue; }
				if (originOf(source) === pageOrigin) continue;
				if (!(root.matches('form') || root.querySelector('form,input,select,textarea'))) continue;
				// A page-level runtime that owns landmarks is the page, not an embed.
				if (root.matches('main,header,nav,footer') || root.querySelector('main,header,nav,footer')) continue;
				if (root.parentElement?.closest('[data-blocks-engine-capture-runtime-owner-script]')) continue;
				const script = embedScript(root, source, pageOrigin);
				if (!script) continue;
				const url = new URL(script.src, document.baseURI);
				const data: Record<string, string> = {};
				for (const name of script.getAttributeNames().filter(attribute => attribute.startsWith('data-') && !attribute.startsWith('data-blocks-engine-')).slice(0, MAX_DATA_ATTRIBUTES)) {
					data[name] = (script.getAttribute(name) ?? '').slice(0, MAX_DATA_VALUE);
				}
				root.setAttribute('data-blocks-engine-capture-runtime-owner-script', url.origin + url.pathname);
				root.setAttribute('data-blocks-engine-capture-runtime-owner-data', JSON.stringify(data));
				marked++;
			}
			return marked;
		},
	};
	Object.defineProperty(window, '__captureRuntimeWidgets', { value: state, configurable: true });
}

type WidgetWindow = Window & { __captureRuntimeWidgets?: {
	origins(): string[];
	remove(origins: string[]): { root: string; origin: string }[];
	mark(pageOrigin: string): number;
} };

export async function installRuntimeWidgetAttribution(context: BrowserContext): Promise<void> {
	await context.addInitScript(observeRuntimeWidgets);
}

/** Remove overlay islands when their runtime script origin differs from the page origin,
 * then stamp in-flow interactive roots those scripts rendered inside authored containers.
 * Best-effort: a page that cannot answer keeps its DOM and capture continues.
 */
export async function removeRuntimeWidgets(page: Page): Promise<{ code: string; reason: string }[]> {
	let removed: { code: string; reason: string }[] = [];
	try {
		const origins: unknown = await page.evaluate(() => (window as WidgetWindow).__captureRuntimeWidgets?.origins() ?? []);
		if (!Array.isArray(origins)) return [];
		const pageOrigin = new URL(page.url()).origin;
		const crossOrigin = origins.filter((origin): origin is string => typeof origin === 'string' && origin !== pageOrigin);
		if (crossOrigin.length) {
			const result: unknown = await page.evaluate(origins => (window as WidgetWindow).__captureRuntimeWidgets?.remove(origins) ?? [], crossOrigin);
			removed = Array.isArray(result) ? diagnostics(result) : [];
		}
		await markRuntimeOwnedRegions(page, pageOrigin);
	} catch {
		// Best-effort: the page keeps its DOM and capture continues.
	}
	return removed;
}

/** Stamp in-flow interactive roots rendered by cross-origin embed scripts (#2038).
 * Export projects the stamp into a stable marker plus source evidence.
 */
async function markRuntimeOwnedRegions(page: Page, pageOrigin: string): Promise<void> {
	await page.evaluate(origin => (window as WidgetWindow).__captureRuntimeWidgets?.mark(origin), pageOrigin);
}

function diagnostics(removed: { root: string; origin: string }[]): { code: string; reason: string }[] {
	return removed.map(({ root, origin }) => ({ code: 'third_party_runtime_widget_removed', reason: `removed ${root}; runtime script origin ${origin}` }));
}
