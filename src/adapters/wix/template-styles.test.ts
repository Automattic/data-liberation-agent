import { describe, expect, it } from 'vitest';
import type { SafeFetchResult } from '../../lib/media-fetch/safe-fetch.js';
import { buildTemplateGroups, templateFingerprint, TEMPLATE_GROUPS_SCHEMA } from '../../lib/template-groups.js';
import { templateStyleNormalization } from './template-styles.js';

const ORIGIN = 'https://site.example';

/**
 * One Thunderbolt server document for a Wix blog post. `contentStyle` is the
 * per-item CSS the runtime generates: an inlined TPA viewer-widget chunk in
 * `data-href` and a page CSS-mapper bundle whose VSM generation marker comes
 * and goes between requests. `templateStyle` is authored CSS that is part of
 * the template itself.
 */
function wixPage( templateStyle: string, contentStyle: string ): string {
	return `<!doctype html><html><head>${ templateStyle }${ contentStyle }</head>
<body><header><nav><ul><li><a href="/">Home</a></li></ul></nav></header>
<main><article class="post"><h1 class="post-title">A title</h1><div class="post-content">Body</div></article></main>
<footer><a href="/about">About</a></footer></body></html>`;
}

const TEMPLATE_STYLE = '<style id="css_masterPage">.site-header{position:sticky}</style>';
/** An inlined blog rich-content chunk: per-item composition and class names. */
const contentChunk = ( classes: string ) =>
	`<style rel="stylesheet" data-href="${ ORIGIN }/services/blog-ooi/1.0/rich-content-viewer.chunk.min.css">.ricos-viewer .${ classes }{margin:0}</style>`;
/** A page CSS-mapper bundle carrying the request-dependent VSM generation marker. */
const mapper = ( marker: boolean ) =>
	`<style id="compCssMappers_lbvjl">${ marker ? '/*** VSM_CSS ***/ ' : '' }.main_MF{padding:20px}</style>`;

const withNormalization = ( html: string, url = `${ ORIGIN }/post/a/` ) =>
	templateFingerprint( html, url, templateStyleNormalization );

const onlyChunks = [ {
	id: null,
	attributes: { 'data-href': `${ ORIGIN }/services/blog-ooi/1.0/rich-content-viewer.chunk.min.css` },
	text: '.a{color:red}',
} ];

describe( 'wix templateStyleNormalization', () => {
	it( 'drops per-item viewer chunks: a page of only chunks has no template style evidence', () => {
		expect( templateStyleNormalization.pageStyles( onlyChunks ) ).toBeNull();
	} );

	it( 'keeps authored template style text, with the page mapper bundles sorted after', () => {
		expect( templateStyleNormalization.pageStyles( [
			{ id: 'css_masterPage', attributes: {}, text: ' .x{a:1} ' },
			{ id: null, attributes: {}, text: '.y{b:2}' },
		] ) ).toBe( '.y{b:2}\n.x{a:1}' );
	} );

	it( 'does not change the generic fingerprint for platforms without the hook', () => {
		// Generic behavior is unchanged for platforms without the hook: the
		// fingerprint hashes every inline style in document order.
		const html = '<html><head></head><body><style>.a{color:red}</style><style>.b{color:blue}</style></body></html>';
		expect( templateFingerprint( html, ORIGIN ).divergence.pageStyles ).not.toBeNull();
	} );
} );

describe( 'wix grouping over per-request page styles (#836)', () => {
	// Two requests to the same blog post: the viewer chunk content and the VSM
	// marker differ, everything else is the same template.
	const first = wixPage( TEMPLATE_STYLE + mapper( true ), contentChunk( 'z0ad9' ) );
	const second = wixPage( TEMPLATE_STYLE + mapper( false ), contentChunk( 'sgICj' ) );
	// A third request fetched the mapper bundle in a different position.
	const reordered = wixPage( mapper( true ) + TEMPLATE_STYLE, contentChunk( 'z0ad9' ) );
	// A different template: its authored layout CSS differs.
	const differentTemplate = wixPage( '<style id="css_masterPage">.site-header{position:static}</style>' + mapper( true ), contentChunk( 'z0ad9' ) );

	it( 'groups requests of one post that differ only in per-item generated CSS', () => {
		expect( withNormalization( second ).key ).toBe( withNormalization( first ).key );
		expect( withNormalization( reordered ).key ).toBe( withNormalization( first ).key );
	} );

	it( 'still diverges when the template layout CSS changes', () => {
		expect( withNormalization( differentTemplate ).key ).not.toBe( withNormalization( first ).key );
	} );

	it( 'folds request-only style churn at group time: the post template reports one group', async () => {
		const routes = new Map( [
			[ `${ ORIGIN }/post/one/`, first ],
			[ `${ ORIGIN }/post/two/`, second ],
			[ `${ ORIGIN }/post/three/`, reordered ],
			[ `${ ORIGIN }/post/different-template/`, differentTemplate ],
		] );
		const fetch = async ( url: string ): Promise< SafeFetchResult > => ( {
			finalUrl: url,
			status: 200,
			headers: new Headers( { 'content-type': 'text/html; charset=utf-8' } ),
			body: Buffer.from( routes.get( url )! ),
		} );
		const fetchDependency = fetch as unknown as typeof import('../../lib/media-fetch/safe-fetch.js').safeFetch;

		const report = await buildTemplateGroups(
			{ sourceUrl: `${ ORIGIN }/post/one/`, urls: [ ...routes.keys() ], styleNormalization: templateStyleNormalization },
			{ fetch: fetchDependency },
		);
		expect( report.schema ).toBe( TEMPLATE_GROUPS_SCHEMA );
		expect( report.coverage.groups ).toBe( 2 );
		expect( report.groups[ 0 ]!.size ).toBe( 3 );
		expect( report.groups[ 1 ]!.size ).toBe( 1 );

		// Without the platform normalization the same documents over-split on
		// the generated content: the generic fingerprint must keep reading it.
		const without = await buildTemplateGroups( { sourceUrl: `${ ORIGIN }/post/one/`, urls: [ ...routes.keys() ] }, { fetch: fetchDependency } );
		expect( without.coverage.groups ).toBeGreaterThan( 2 );
	} );
} );
