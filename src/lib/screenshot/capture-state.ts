import type { Page } from 'playwright';
import type { ScriptMotion } from '../viewport-entrances.js';
import { settleDocument } from './page-helpers.js';

/** Read document-clock animations at a fixed point, not at whatever progress
 * the wall clock reached: finite motion at its end, perpetual motion at time
 * zero. Declarative (CSS) motion only has its clock moved; nothing is written
 * into the document, so the source's declared motion stays intact for the
 * motion owner. A script's own WAAPI animation has no owner in the copy, which
 * never runs that script: a finished one that holds its end pose by fill has
 * that pose committed to inline style, the only place serialization reads it
 * (#1466). Native scroll and view timelines are not clocks and belong to the
 * native-timeline capture. Runs in the page.
 */
export function finishDocumentAnimations(): void {
	for (const animation of document.getAnimations()) {
		const effect = animation.effect;
		if (animation.timeline !== document.timeline || !effect) continue;
		try {
			if (Number.isFinite(Number(effect.getComputedTiming().endTime))) animation.finish();
			else { animation.pause(); animation.currentTime = 0; }
		} catch { /* an effect without a resolvable timing has no clock to set */ }
		if (animation instanceof CSSAnimation || animation instanceof CSSTransition || !(effect instanceof KeyframeEffect)) continue;
		if (!effect.target || effect.pseudoElement || animation.playState !== 'finished') continue;
		const fill = effect.getComputedTiming().fill;
		if (fill !== 'forwards' && fill !== 'both') continue;
		try { animation.commitStyles(); } catch { /* an unrendered target has no computed pose to commit */ }
	}
}

/** Restore the baseline before reading initial components, geometry or chrome. */
export async function normalizeCaptureState(page: Page): Promise<void> {
	await page.evaluate(async () => {
		window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	});
	await settleDocument(page, 'capture-baseline', { quietMs: 200, timeoutMs: 2_000 });
	await page.evaluate(finishDocumentAnimations);
}

/** Longest a settle may wait, sweep included. */
export const SCRIPT_MOTION_BUDGET_MS = 4_000;
/** Inline motion silence that counts as rest: several frames at any refresh rate. */
const SCRIPT_MOTION_QUIET_MS = 150;

/** Bring script entrances to rest before a document is read (#1466).
 *
 * A runtime that remounts when the viewport changes (root-class probes and
 * width sweeps resize the page) replays its entrances: elements in view restart
 * mid-flight, and elements below the fold return to their start pose because
 * nothing scrolls them into view again. When the source has shown
 * scroll-triggered script motion and the viewport changed since the last
 * settle, scroll the document once so its own observers fire again, return to
 * the top, and wait — bounded — until inline motion writes stop and finite
 * script animations end. Finished script animations are then committed like
 * the baseline's. A page with no script motion pays only one evaluate.
 */
export async function settleScriptMotion(page: Page, budgetMs = SCRIPT_MOTION_BUDGET_MS): Promise<{ swept: boolean; quiet: boolean }> {
	const outcome = await page.evaluate(async ({ budgetMs, quietMs }) => {
		const scope = window as typeof window & { __dlaEntrances?: { motion?: ScriptMotion }; __dlaScriptMotionSettledResizes?: number };
		const motion = () => scope.__dlaEntrances?.motion;
		const initial = motion();
		if (!initial) return { swept: false, quiet: true };
		const deadline = performance.now() + budgetMs;
		const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
		const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
		const swept = initial.scrollTriggered && initial.resizes !== (scope.__dlaScriptMotionSettledResizes ?? 0);
		if (swept) {
			const root = document.scrollingElement ?? document.documentElement;
			const step = Math.max(200, Math.round(innerHeight * 0.8));
			// Leave half the budget for the motion this sweep starts to finish.
			for (let top = step; performance.now() < deadline - budgetMs / 2; top += step) {
				const bottom = Math.max(0, root.scrollHeight - innerHeight);
				window.scrollTo({ top: Math.min(top, bottom), left: 0, behavior: 'instant' });
				await frame(); await frame(); await wait(50);
				if (top >= bottom) break;
			}
			// The natural bottom leaves the last band outside an observer with a
			// negative root margin; give it half a viewport more, as the lazy-load
			// sweep does (#1251).
			const total = root.scrollHeight;
			const tail = document.createElement('div');
			tail.style.cssText = `position:absolute!important;top:${total}px!important;left:0!important;width:1px!important;height:${innerHeight}px!important;pointer-events:none!important;visibility:hidden!important;`;
			document.documentElement.appendChild(tail);
			try {
				window.scrollTo({ top: Math.max(0, Math.min(total - innerHeight / 2, root.scrollHeight - innerHeight)), left: 0, behavior: 'instant' });
				await frame(); await frame(); await wait(50);
			} finally {
				tail.remove();
			}
			window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
			await frame(); await frame();
		}
		const running = () => document.getAnimations().some(animation => animation.playState === 'running' &&
			!(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition) && animation.timeline === document.timeline &&
			Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)));
		// Rest is both wall-clock silence and silent frames: a renderer busy
		// decoding can space a spring's frames further apart than the silence.
		let quiet = false, silentFrames = 0, lastMotion = NaN;
		while (!quiet && performance.now() < deadline) {
			const state = motion();
			silentFrames = state?.at === lastMotion ? silentFrames + 1 : 0;
			lastMotion = state?.at ?? NaN;
			quiet = (state?.quietMs ?? Infinity) >= quietMs && silentFrames >= 3 && !running();
			if (!quiet) await Promise.race([frame(), wait(Math.max(0, deadline - performance.now()))]);
		}
		scope.__dlaScriptMotionSettledResizes = motion()?.resizes ?? initial.resizes;
		return { swept, quiet };
	}, { budgetMs, quietMs: SCRIPT_MOTION_QUIET_MS });
	await page.evaluate(finishDocumentAnimations);
	return outcome;
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
