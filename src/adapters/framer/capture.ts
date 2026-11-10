import { load } from 'cheerio';
import postcss from 'postcss';
import type { LiberationHooks } from '../page-actions.js';
import { getSourceResponse } from '../../lib/browser-kit/source-traffic.js';

/** No hydrated render exists in this pre-navigation loader. Only fall back for
 * explicit animation hints and simple entrance poses, not arbitrary hidden UI. */
export function settleFramerEntranceStyle(style: string): string {
	try {
		const declarations = postcss.parse(`a{${style}}`).first;
		if (!declarations || declarations.type !== 'rule') return style;
		const values = new Map<string, string>();
		declarations.walkDecls(declaration => { values.set(declaration.prop.toLowerCase(), declaration.value.trim()); });
		const hints = (values.get('will-change') ?? '').split(',').map(value => value.trim());
		const opacity = values.get('opacity');
		const fades = opacity !== undefined && /^\d*\.?\d+$/.test(opacity) && Number(opacity) < 1;
		const transform = values.get('transform');
		// Do not mistake rotations, matrices, CSS variables or positioning formulas
		// for entrances. A mixed transform must remain intact.
		const moves = transform !== undefined && /^(?:(?:translate(?:X|Y|Z|3d)?|scale(?:X|Y|Z|3d)?)\(\s*-?(?:\d*\.)?\d+(?:px|%|em|rem|vw|vh)?(?:\s*,\s*-?(?:\d*\.)?\d+(?:px|%|em|rem|vw|vh)?){0,2}\s*\)\s*)+$/.test(transform);
		if ((!fades && !moves) || !hints.some(hint => hint === 'transform' || hint === 'opacity')) return style;
		if (transform && transform !== 'none' && !moves) return style;
		declarations.walkDecls(declaration => {
			if (fades && declaration.prop.toLowerCase() === 'opacity') declaration.value = '1';
			if (moves && declaration.prop.toLowerCase() === 'transform') declaration.value = 'none';
		});
		return declarations.nodes.map(node => node.toString()).join(';');
	} catch { return style; }
}

/** Framer's SSR variants already select layout through authored media queries.
 * Its hydration bundle deletes the inactive siblings, destroying that tree. */
export const loadFramerDocument: NonNullable<LiberationHooks['loadDocument']> = async (page, url, timeout) => {
	const response = await getSourceResponse(page.context(), url, { timeout, maxRedirects: 0 });
	try {
		if (!response.ok()) return undefined;
		const source = await response.text();
		const $ = load(source);
		if (!$('.ssr-variant[class*="hidden-"]').length) return undefined;
		const bundles = $('script[data-framer-bundle], script[type="module"][src]').filter((_index, element) => {
			if ($(element).is('[data-framer-bundle]')) return true;
			try { return new URL($(element).attr('src')!, url).hostname === 'framerusercontent.com'; }
			catch { return false; }
		});
		if (!bundles.length) return undefined;
		bundles.remove();
		$('[style]').each((_index, element) => {
			const node = $(element);
			node.attr('style', settleFramerEntranceStyle(node.attr('style')!));
		});
		return { html: $.html(), headers: response.headers() };
	} finally { await response.dispose(); }
};
