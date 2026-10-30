import type { Page } from 'playwright';
import type { CapturedComponent } from './component-states.js';

export interface CollectionMember { key: string; url?: string; text: string; html: string }
export interface CollectionEvidence {
	members: CollectionMember[];
	states: Array<{ id: string; trigger?: { selector: string; action: 'click' | 'fill' | 'select'; value?: string }; members: string[] }>;
	controls: string[];
	coverage: 'complete' | 'partial';
	limits: { pages: number; members: number; controls: number };
	replay: 'unsupported';
}

/** Discover a repeated region and its nearest control-owning ancestor, without site vocabulary. */
export async function collectionRegions(page: Page, skip?: string): Promise<Array<{ selector: string; owner: string }>> {
	return page.evaluate(excluded => {
		const selector = (node: Element): string => {
			if (node.id) return '#' + CSS.escape(node.id);
			const parts: string[] = [];
			while (node !== document.body && node.parentElement) {
				const siblings = Array.from(node.parentElement.children).filter(other => other.tagName === node.tagName);
				parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
				node = node.parentElement;
			}
			return 'body > ' + parts.join(' > ');
		};
		const found: Array<{ selector: string; owner: string }> = [];
		for (const root of document.querySelectorAll('main *,section,ul,[role="list"]')) {
			if (root.closest('header,footer,nav') || excluded && root.matches(excluded)) continue;
			const children = Array.from(root.children);
			if (children.length < 2 || children.length > 200 || !children.every(child => child.tagName === children[0].tagName && child.querySelector('a[href]') && (child.textContent ?? '').trim())) continue;
			if (found.some(region => root.closest(region.selector))) continue;
			let owner: Element | null = root.parentElement;
			for (let depth = 0; owner && owner !== document.body && depth < 3; depth++, owner = owner.parentElement) {
				if (!owner.querySelector('button,input[type="search"],select')) continue;
				found.push({ selector: selector(root), owner: selector(owner) }); break;
			}
		}
		return found.slice(0, 4);
	}, skip);
}

/** Probe a disposable document: exploratory state can never overwrite the initial route tree. */
export async function captureCollections(page: Page, skip?: string): Promise<CapturedComponent[]> {
	const regions = await collectionRegions(page, skip);
	if (!regions.length) return [];
	const probe = await page.context().newPage();
	const result: CapturedComponent[] = [];
	const limits = { pages: 20, members: 200, controls: 24 };
	const deadline = Date.now() + 60_000;
	try {
		for (const region of regions) {
			await probe.goto(page.url(), { waitUntil: 'networkidle', timeout: 15_000 });
			const evidence: CollectionEvidence = { members: [], states: [], controls: [], coverage: 'complete', limits, replay: 'unsupported' };
			const component: CapturedComponent = { selector: region.selector, kind: 'collection', initial: 'initial', states: [{ id: 'initial', html: await probe.locator(region.selector).evaluate(node => node.outerHTML) }], transitions: [], status: 'captured', collection: evidence };
			result.push(component);
			const observe = async (): Promise<string[]> => {
				const members = await probe.locator(region.selector).evaluate(root => Array.from(root.children).filter(child => {
					const style = getComputedStyle(child); return !child.hasAttribute('hidden') && style.display !== 'none' && style.visibility !== 'hidden' && child.getBoundingClientRect().height > 0;
				}).map(child => {
					const anchor = child.querySelector<HTMLAnchorElement>('a[href]');
					const url = anchor?.href;
					const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
					const media = Array.from(child.querySelectorAll('img')).map(img => img.getAttribute('src') ?? '').join('|');
					return { key: url || `text:${text}|media:${media}`, ...(url ? { url } : {}), text, html: child.outerHTML };
				}));
				for (const member of members) if (!evidence.members.some(item => item.key === member.key)) {
					if (evidence.members.length >= limits.members) { evidence.coverage = 'partial'; break; }
					evidence.members.push(member);
				}
				return members.map(member => member.key);
			};
			const controls = await probe.locator(region.owner).evaluate(root => {
				const selector = (node: Element): string => {
					if (node.id) return '#' + CSS.escape(node.id);
					const parts: string[] = [];
					while (node !== document.body && node.parentElement) {
						const siblings = Array.from(node.parentElement.children).filter(other => other.tagName === node.tagName);
						parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`); node = node.parentElement;
					}
					return 'body > ' + parts.join(' > ');
				};
				return Array.from(root.querySelectorAll('button,input[type="search"],select')).map(node => ({ selector: selector(node), tag: node.tagName, label: node.getAttribute('aria-label') || node.textContent || '', options: node instanceof HTMLSelectElement ? Array.from(node.options).map(option => option.value) : [] }));
			});
			evidence.controls = controls.map(control => control.selector);
			if (controls.length > limits.controls) evidence.coverage = 'partial';
			const next = controls.find(control => /^(?:next(?: page)?|load more|show more|older|›|»|→)$/i.test(control.label.trim()));
			const exhaust = async (id: string, trigger?: CollectionEvidence['states'][number]['trigger']) => {
				const union: string[] = [];
				let previous = '';
				for (let index = 0; index < limits.pages; index++) {
					const keys = await observe();
					for (const key of keys) if (!union.includes(key)) union.push(key);
					const signature = JSON.stringify(keys);
					if (index === 0 && id === 'initial') evidence.states.push({ id: 'initial', members: keys });
					if (index > 0 && signature !== previous && next) evidence.states.push({ id: `${id}-page-${index}`, trigger: { selector: next.selector, action: 'click' }, members: keys });
					if (!next || signature === previous) break;
					previous = signature;
					const button = probe.locator(next.selector);
					if (!await button.isVisible() || !await button.isEnabled() || await button.getAttribute('aria-disabled') === 'true') break;
					if (index === limits.pages - 1 || Date.now() > deadline) { evidence.coverage = 'partial'; break; }
					await button.click({ timeout: 1_000 }); await probe.waitForTimeout(300);
				}
				evidence.states.push({ id: id === 'initial' ? 'all-pages' : id, ...(trigger ? { trigger } : {}), members: union });
			};
			await exhaust('initial');
			for (const [index, control] of controls.slice(0, limits.controls).entries()) {
				if (Date.now() > deadline) { evidence.coverage = 'partial'; break; }
				if (/^(?:next(?: page)?|previous(?: page)?|prev|load more|show more|older|›|»|→|‹|«|←)$/i.test(control.label.trim())) continue;
				const values = control.tag === 'SELECT' ? control.options : control.tag === 'INPUT' ? [evidence.members[0]?.text.split(/\s+/)[0] ?? '', '__capture_no_matching_record__', ''] : [undefined];
				for (const [variant, value] of values.entries()) {
					await probe.goto(page.url(), { waitUntil: 'networkidle', timeout: 15_000 });
					const target = probe.locator(control.selector);
					if (!await target.isVisible()) {
						const opener = probe.locator(region.owner).getByRole('button', { name: /^filters?$/i }).first();
						if (await opener.isVisible()) await opener.click({ timeout: 1_000 });
					}
					const action = control.tag === 'INPUT' ? 'fill' : control.tag === 'SELECT' ? 'select' : 'click';
					try {
						if (action === 'fill') await target.fill(value!, { timeout: 1_000 });
						else if (action === 'select') await target.selectOption(value!, { timeout: 1_000 });
						else await target.click({ timeout: 1_000 });
						await probe.waitForTimeout(300);
						if (new URL(probe.url()).pathname !== new URL(page.url()).pathname) { evidence.coverage = 'partial'; continue; }
						await exhaust(`control-${index}-${variant}`, { selector: control.selector, action, ...(value !== undefined ? { value } : {}) });
					} catch { evidence.coverage = 'partial'; }
				}
			}
			component.status = evidence.coverage === 'complete' ? 'captured' : 'partial';
			component.reason = evidence.coverage === 'complete' ? 'Collection membership captured; collection control replay unsupported' : 'Collection exploration bounded or failed; member universe partial; collection control replay unsupported';
		}
	} finally { await probe.close(); }
	return result;
}
