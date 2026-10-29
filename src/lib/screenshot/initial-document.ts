import * as cheerio from 'cheerio';
import postcss from 'postcss';
import type { Page } from 'playwright';
import { isStackingArtifact } from './document-integrity.js';

const NODE = 'data-blocks-engine-capture-initial-node';
const GEOMETRY = new Set(['width', 'height', 'font-size', 'padding-top', 'transform', 'inset', 'top', 'left', 'min-height', 'aspect-ratio']);

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
	await page.evaluate(attribute => {
		let index = 0;
		for (const node of document.querySelectorAll('body,body *')) node.setAttribute(attribute, String(index++));
	}, NODE);
}

/** Only learned style declarations may cross back from exploration to the initial tree. */
export function projectInitialDocument(initial: string, learned: string): string {
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
				if (name.startsWith('data-blocks-engine-capture-') && name !== NODE) target.attr(name, value);
			}
			if (source.attr('style') !== undefined || source.attr('data-blocks-engine-capture-fluid-segment')) {
				target.attr('style', learnedStyle(target.attr('style') ?? '', source.attr('style') ?? ''));
				for (const name of ['data-blocks-engine-capture-fluid-id', 'data-blocks-engine-capture-fluid-segment']) {
					const value = source.attr(name);
					if (value !== undefined) target.attr(name, value);
				}
			}
		}
		target.removeAttr(NODE);
	});
	for (const node of later('style[data-blocks-engine-capture-fluid-rules],style[data-blocks-engine-capture-fluid-sheet-rules]').toArray()) $('head').append(later(node).toString());
	return $.html();
}
