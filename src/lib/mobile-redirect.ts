import { parse } from 'acorn';
import { load } from 'cheerio';
import { sameHttpSite } from './screenshot/same-origin.js';

export interface MobileRedirect {
	kind: 'mobile-redirect';
	source: string;
	viewport: { width: number; height: number };
	target: string;
	trigger: { kind: 'inline-script'; condition: string; script: string };
	held: true;
}

// Deliberately recognize declarations, not arbitrary JavaScript. Unknown scripts
// still execute under the main-frame navigation guard. No source code is eval'd.
interface Syntax {
	type: string; start: number; end: number;
	body?: Syntax[]; test?: Syntax; consequent?: Syntax; alternate?: Syntax;
	expression?: Syntax; operator?: string; left?: Syntax; right?: Syntax;
	object?: Syntax; property?: Syntax; computed?: boolean; name?: string; value?: unknown;
}
function member(node: Syntax | undefined, object: string, property: string): boolean {
	return node?.type === 'MemberExpression' && !node.computed && node.object?.name === object && node.property?.name === property;
}
function width(node: Syntax | undefined): boolean {
	return member(node, 'screen', 'width') || member(node, 'window', 'innerWidth') || node?.type === 'Identifier' && node.name === 'innerWidth';
}
function condition(node: Syntax, viewport: number): boolean | undefined {
	if (node.type !== 'BinaryExpression') return;
	const left = width(node.left) ? viewport : node.left?.type === 'Literal' ? node.left.value : undefined;
	const right = width(node.right) ? viewport : node.right?.type === 'Literal' ? node.right.value : undefined;
	if ((!width(node.left) && !width(node.right)) || typeof left !== 'number' || typeof right !== 'number') return;
	switch (node.operator) {
		case '<': return left < right;
		case '<=': return left <= right;
		case '>': return left > right;
		case '>=': return left >= right;
		default: return;
	}
}
function location(node: Syntax | undefined): boolean {
	return node?.type === 'Identifier' && node.name === 'location' ||
		member(node, 'document', 'location') || member(node, 'window', 'location') ||
		(node?.type === 'MemberExpression' && !node.computed && node.property?.name === 'href' && location(node.object));
}

/** Hold only explicit small-screen same-site assignments, keeping all other script bytes intact. */
export function holdMobileRedirects(html: string, source: string, viewport: {width: number; height: number}): { html: string; redirects: MobileRedirect[] } {
	// Most documents have no width-driven location assignment. Do not build a
	// second full DOM (and parse every inline application bundle) on the shared
	// navigation path for those pages. These are only lexical admission checks;
	// the AST below remains the authority for classification.
	if (!/\b(?:screen|innerWidth)\b/.test(html) || !/\blocation\b/.test(html)) return {html, redirects: []};
	const $ = load(html, { sourceCodeLocationInfo: true });
	const redirects: MobileRedirect[] = [];
	const edits: Array<{start: number; end: number}> = [];
	$('script:not([src])').each((_index, element) => {
		const type = ($(element).attr('type') ?? '').trim().toLowerCase();
		if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) return;
		const script = $(element).text();
		if (!/\b(?:screen|innerWidth)\b/.test(script) || !/\blocation\b/.test(script)) return;
		let ast: Syntax;
		try { ast = parse(script, {ecmaVersion: 'latest', sourceType: type === 'module' ? 'module' : 'script'}) as unknown as Syntax; } catch { return; }
		for (const statement of ast.body ?? []) {
			if (statement.type !== 'IfStatement' || statement.alternate || !statement.test || condition(statement.test, viewport.width) !== true || condition(statement.test, 1440) !== false) continue;
			const body = statement.consequent?.type === 'BlockStatement' ? statement.consequent.body : [statement.consequent];
			if (body?.length !== 1) continue;
			const expression = body[0]?.expression;
			if (expression?.type !== 'AssignmentExpression' || expression.operator !== '=' || !location(expression.left) || expression.right?.type !== 'Literal' || typeof expression.right.value !== 'string') continue;
			let target: URL;
			try { target = new URL(expression.right.value, new URL($('base[href]').first().attr('href') ?? source, source)); } catch { continue; }
			if (!sameHttpSite(target.href, source) || target.username || target.password) continue;
			// Normalize only scheme and www/bare identity; retain the target route.
			const origin = new URL(source);
			target.protocol = origin.protocol; target.host = origin.host;
			const start = element.sourceCodeLocation?.startTag?.endOffset;
			if (start === undefined) continue;
			edits.push({start: start + expression.start, end: start + expression.end});
			redirects.push({kind: 'mobile-redirect', source, viewport, target: target.href, trigger: {kind: 'inline-script', condition: script.slice(statement.test.start, statement.test.end), script}, held: true});
		}
	});
	for (const edit of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, edit.start) + 'void 0 /* capture held mobile redirect */' + html.slice(edit.end);
	return {html, redirects};
}
