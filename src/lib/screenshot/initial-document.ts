import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import postcss from 'postcss';
import type { Page } from 'playwright';
import { isStackingArtifact } from './document-integrity.js';
import { RUNTIME_SHEET_PRUNED_ATTRIBUTE } from './fluid-runtime-sheets.js';
import { WIDTH_CLASSES_ATTRIBUTE, projectViewportClassRules } from './viewport-class-states.js';

const NODE = 'data-blocks-engine-capture-initial-node';
export const INITIAL_SCROLL_CLASS_ATTRIBUTE = 'data-blocks-engine-capture-initial-scroll-class';

/** Record before any scrolling; subsequent initial-document marking must not overwrite it. */
export async function markInitialScrollClasses(page: Page): Promise<void> {
	await page.evaluate(attribute => {
		// The baseline and fluid passes both mark the document. Scan once per
		// body, even when no positioned elements exist; later scroll poses are
		// not initial evidence. Keeping this sentinel off-DOM also leaves
		// disclosure restoration's markup comparisons untouched.
		const state = window as unknown as { __dlaInitialScrollBody?: HTMLElement };
		if (state.__dlaInitialScrollBody === document.body) return;
		state.__dlaInitialScrollBody = document.body;
		for (const node of document.querySelectorAll('body,body *')) {
			if (node.hasAttribute(attribute)) continue;
			const position = getComputedStyle(node).position;
			if (position === 'fixed' || position === 'sticky') node.setAttribute(attribute, JSON.stringify(node.getAttribute('class')));
		}
	}, INITIAL_SCROLL_CLASS_ATTRIBUTE);
}
// Every property capture rewrites in the live DOM must be listed: an unlisted
// one keeps its initial value, e.g. a max-height lifted to 100vh alongside its
// height would serialize back as the capture viewport's pixels and clamp it.
const GEOMETRY = new Set(['width', 'height', 'font-size', 'padding-top', 'transform', 'transform-origin', 'clip-path', 'inset', 'top', 'left', 'min-height', 'max-height', 'aspect-ratio']);

function learnedStyle(initial: string, learned: string): string {
	try {
		const before = postcss.parse(`x{${initial}}`).first as postcss.Rule;
		const after = postcss.parse(`x{${learned}}`).first as postcss.Rule;
		before.walkDecls(declaration => { if (GEOMETRY.has(declaration.prop)) declaration.remove(); });
		after.walkDecls(declaration => { if (GEOMETRY.has(declaration.prop)) before.append(declaration.clone()); });
		return before.nodes.map(node => node.toString()).join(';');
	} catch {
		return initial;
	}
}

/** Stable correspondence for applying learned geometry without replacing initial content/state. */
export async function markInitialDocument(page: Page): Promise<void> {
	await markInitialScrollClasses(page);
	await page.evaluate(attribute => {
		let index = 0;
		for (const node of document.querySelectorAll('body,body *')) node.setAttribute(attribute, String(index++));
	}, NODE);
}

/** Apply sweep aliases only where this state's capture-width classes agree. */
export function applyWidthClasses(target: cheerio.Cheerio<Element>): void {
	const marked = target.attr(WIDTH_CLASSES_ATTRIBUTE);
	if (marked === undefined) return;
	target.removeAttr(WIDTH_CLASSES_ATTRIBUTE);
	let pairs: unknown;
	try {
		pairs = JSON.parse(marked);
	} catch {
		return;
	}
	if (!Array.isArray(pairs)) return;
	for (const pair of pairs) {
		if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
		// The sweep describes the initial component state, not every state
		// that later reuses this DOM node. Missing evidence is not agreement.
		if (typeof pair[2] !== 'boolean' || target.hasClass(pair[0]) !== pair[2]) continue;
		target.removeClass(pair[0]).addClass(pair[1]);
	}
}

/** Only learned style declarations may cross back from exploration to the initial tree. */
export function projectInitialDocument(initial: string, learned: string, linkedSheet?: Parameters<typeof projectViewportClassRules>[1]): string {
	// Parsing would repair nested bodies and hide the integrity violation.
	if (isStackingArtifact(initial) || isStackingArtifact(learned)) return isStackingArtifact(initial) ? initial : learned;
	const $ = cheerio.load(initial);
	const later = cheerio.load(learned);
	const learnedById = new Map(later(`[${NODE}]`).toArray().map(node => [later(node).attr(NODE)!, node]));
	$(`[${NODE}]`).each((_index, node) => {
		const target = $(node);
		const matched = learnedById.get(target.attr(NODE)!);
		if (matched) {
			const source = later(matched);
			// A width sweep may have caused a framework render. Geometry is only
			// transferable to the same element, not its replacement or new content.
			for (const [name, value] of Object.entries(source.attr() ?? {})) {
				if (name.startsWith('data-blocks-engine-capture-') && name !== NODE && name !== INITIAL_SCROLL_CLASS_ATTRIBUTE) target.attr(name, value);
			}
			applyWidthClasses(target);
			if (source.attr('style') !== undefined || source.attr('data-blocks-engine-capture-fluid-segment')) {
				target.attr('style', learnedStyle(target.attr('style') ?? '', source.attr('style') ?? ''));
				for (const name of ['data-blocks-engine-capture-fluid-id', 'data-blocks-engine-capture-fluid-segment']) {
					const value = source.attr(name);
					if (value !== undefined) target.attr(name, value);
				}
			}
		}
		target.removeAttr(NODE);
		target.removeAttr(INITIAL_SCROLL_CLASS_ATTRIBUTE);
	});
	for (const node of later('style[data-blocks-engine-capture-fluid-rules],style[data-blocks-engine-capture-fluid-sheet-rules]').toArray()) $('head').append(later(node).toString());
	// A runtime sheet whose fitted declarations the authored cascade reproduces
	// serializes without them; its capture-width text identifies it.
	for (const node of later(`style[${RUNTIME_SHEET_PRUNED_ATTRIBUTE}]`).toArray()) {
		const from = later(node).attr(RUNTIME_SHEET_PRUNED_ATTRIBUTE);
		const to = later(node).text();
		$('style').filter((_index, style) => $(style).text() === from).text(to);
	}
	return projectViewportClassRules($.html(), linkedSheet);
}
