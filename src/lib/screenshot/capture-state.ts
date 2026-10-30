import type { Page } from 'playwright';
import { settleDocument } from './page-helpers.js';

/** Restore the baseline before reading initial components, geometry or chrome.
 * Document-clock animations are read at a fixed point, not at whatever progress
 * the wall clock reached: finite motion at its end, perpetual motion at time
 * zero. Only the clock moves; nothing is written into the document, so the
 * source's declared motion stays intact for the motion owner. Native scroll and
 * view timelines are not clocks and belong to the native-timeline capture.
 */
export async function normalizeCaptureState(page: Page): Promise<void> {
	await page.evaluate(async () => {
		window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	});
	await settleDocument(page, 'capture-baseline', { quietMs: 200, timeoutMs: 2_000 });
	await page.evaluate(() => {
		for (const animation of document.getAnimations()) {
			if (animation.timeline !== document.timeline || !animation.effect) continue;
			try {
				if (Number.isFinite(Number(animation.effect.getComputedTiming().endTime))) animation.finish();
				else { animation.pause(); animation.currentTime = 0; }
			} catch { /* an effect without a resolvable timing has no clock to set */ }
		}
	});
}

/** Framework counters are capture-session identities, not authored anchors.
 * Number within each outer landmark so route-local content before a footer
 * cannot shift the footer's identities. References are rewritten as tokens,
 * never as substrings (including escaped CSS ID selectors).
 */
export async function normalizeGeneratedIds(page: Page): Promise<void> {
	await page.evaluate(() => {
		const generated = /^(?::[rR][\w-]*:|radix-:[rR][\w-]*:.*|headlessui-[\w-]+-\d+)$/;
		const landmarks = 'header,nav,footer,[role="banner"],[role="navigation"],[role="contentinfo"]';
		const roots = Array.from(document.querySelectorAll(landmarks)).filter(node => !node.parentElement?.closest(landmarks));
		const counts = new Map<Element, number>();
		const mapping = new Map<string, string>();
		for (const node of document.querySelectorAll('[id]')) {
			if (!generated.test(node.id)) continue;
			const root = roots.find(root => root.contains(node)) ?? document.documentElement;
			const scope = root === document.documentElement ? 'document' : `${root.tagName.toLowerCase()}-${roots.filter(other => other.tagName === root.tagName).indexOf(root)}`;
			let index = counts.get(root) ?? 0;
			let id: string;
			do { id = `capture-generated-${scope}-${index++}`; } while (document.getElementById(id));
			counts.set(root, index);
			// Duplicate source IDs remain duplicates, so the integrity gate can
			// still report them rather than silently inventing a relationship.
			if (!mapping.has(node.id)) mapping.set(node.id, id);
		}
		if (!mapping.size) return;
		const tokens = new Set(['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-flowto', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'for', 'list', 'headers', 'form']);
		for (const node of document.querySelectorAll('*')) {
			for (const attribute of Array.from(node.attributes)) {
				const { name, value } = attribute;
				if (name === 'id' && mapping.has(value)) node.setAttribute(name, mapping.get(value)!);
				else if (tokens.has(name)) node.setAttribute(name, value.replace(/\S+/g, token => mapping.get(token) ?? token));
				else if ((name === 'href' || name === 'xlink:href') && value.startsWith('#')) {
					let fragment = value.slice(1);
					try { fragment = decodeURIComponent(fragment); } catch { /* malformed fragment is not a generated reference */ }
					if (mapping.has(fragment)) node.setAttribute(name, `#${mapping.get(fragment)}`);
				}
			}
		}
		const rewrite = (value: string) => {
			for (const [from, to] of mapping) {
				const escaped = CSS.escape(from);
				const pattern = escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				value = value.replace(new RegExp(`#${pattern}(?![\\w-])`, 'g'), `#${to}`);
				value = value.split(`url(#${from})`).join(`url(#${to})`);
			}
			return value;
		};
		const rules = (list: CSSRuleList) => {
			for (const rule of Array.from(list)) {
				if (rule instanceof CSSStyleRule) rule.selectorText = rewrite(rule.selectorText);
				if ('cssRules' in rule) rules((rule as CSSGroupingRule).cssRules);
			}
		};
		for (const sheet of Array.from(document.styleSheets)) {
			try { rules(sheet.cssRules); } catch { /* opaque cross-origin stylesheet */ }
		}
		for (const node of document.querySelectorAll('[style]')) node.setAttribute('style', rewrite(node.getAttribute('style')!));
	});
}
