import { describe, expect, it } from 'vitest';
import { compareDerivedWithCapture, deriveMemberDocument, TEMPLATE_CLUSTERS_SCHEMA, writeTemplateClusters } from './template-clusters.js';
import { templateFingerprint } from './template-groups.js';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The #784 phase-1 fixture, reduced from the 24-route acceptance fixture: a
 * home page and six posts sharing one template, one post with a two-column
 * page-local `<style>` (the post-9 case that a skeleton alone cannot see),
 * one tabs post, and one form post.
 */
const BASE = 'https://fixture.test';

// Content lives in the body only: the handshake fixtures share one head, so
// the cluster key separates members solely on body content.
const serverDocument = ( title: string, body = entry( [ 'First paragraph.', 'Second paragraph.' ], title ), extraStyle = '' ): string => `<!doctype html>
<html><head><title>Fixture</title>${ extraStyle }</head>
<body>${ body }</body></html>`;

const entry = ( paragraphs: string[], title = '' ): string => `<header class="site-header"><nav class="menu" aria-label="Main"><a href="/">Home</a></nav></header>
<article class="post"><h1 class="post-title">${ title || titleOf( paragraphs[ 0 ]! ) }</h1><div class="entry-content">${ paragraphs.map( paragraph => `<p>${ paragraph }</p>` ).join( '\n' ) }<figure class="wp-block-image"><img src="/img/figure-${ titleOf( title || paragraphs[ 0 ]! ) }.jpg" alt="Figure" loading="lazy" width="1200" height="675"></figure></div></article>
<footer class="site-footer"><p>© Fixture</p></footer>`;

const titleOf = ( first: string ): string => first.replace( /[^a-z0-9]+/gi, '-' ).toLowerCase();

const PROCESSED = ( title: string ): string => `<!doctype html>
<html><head><title>Fixture</title>
<style data-blocks-engine-capture-fluid-sheet-rules>@media (max-width: 1440px){.hero{height:25vw}}</style></head>
<body><header class="site-header"><nav class="menu" aria-label="Main"><a href="/">Home</a></nav></header>
<article class="post"><h1 class="post-title">${ title }</h1><div class="entry-content"><p>First paragraph.</p><p>Second paragraph.</p><figure class="wp-block-image"><img src="${ BASE }/img/figure-${ titleOf( title ) }.jpg" alt="Figure" loading="lazy" width="1200" height="675"></figure></div></article>
<footer class="site-footer"><p>© Fixture</p></footer></body></html>`;

const representative = {
	repServerHtml: serverDocument( 'post-1' ),
	repProcessedHtml: PROCESSED( 'post-1' ),
	baseUrl: BASE,
};

const REAL_CAPTURE = ( title: string ): string => PROCESSED( title )


describe( 'template-clusters (phase 1 transplant, #784)', () => {
	it( 'groups shared-template posts and isolates the divergent members', () => {
		const regular = templateFingerprint( serverDocument( 'post-1' ), BASE );
		expect( templateFingerprint( serverDocument( 'post-2' ), BASE ).key ).toBe( regular.key );
		expect( templateFingerprint( serverDocument( 'post-3' ), BASE ).key ).toBe( regular.key );
		// The page-local style is a different template even though the skeleton matches.
		expect( templateFingerprint( serverDocument( 'post-9', undefined, '<style>.entry-content{column-gap:2em}</style>' ), BASE ).key ).not.toBe( regular.key );
		// Tabs and forms diverge from the plain post.
		const tabs = templateFingerprint( serverDocument( 'post-5', entry( [ 'Tabbed post.' ] ).replace( '</article>', '<div class="tabs" role="tablist"><button role="tab">A</button><button role="tab">B</button></div></article>' ) ), BASE );
		expect( tabs.key ).not.toBe( regular.key );
		const form = templateFingerprint( serverDocument( 'post-13', entry( [ 'Form post.' ] ).replace( '</article>', '<form class="newsletter" action="/subscribe"><input type="email"></form></article>' ) ), BASE );
		expect( form.key ).not.toBe( regular.key );
	} );

	it( 'derives a member equal to its real capture on text, links, images, skeleton, fluid rules and head styles', () => {
		// post-2's fingerprinted head slots differ (title/description/canonical),
		// so it cannot sit in the representative's cluster; derive it from the
		// representative's key-compatible content instead.
		const derivation = deriveMemberDocument( { ...representative, memberServerHtml: serverDocument( 'post-2' ) } );
		expect( derivation.ok ).toBe( true );
		if ( ! derivation.ok ) return;
		// The <h1> text and the figure's src differ (asset keyed by article);
		// both paragraphs are identical between the fixture members.
		expect( derivation.stats ).toEqual( { slots: 2, subtreeSlots: 0 } );
		const comparison = compareDerivedWithCapture( { derivedHtml: derivation.html, realHtml: REAL_CAPTURE( 'post-2' ), baseUrl: BASE } );
		expect( comparison.checks ).toEqual( {
			text: true, links: true, images: true, skeleton: true, headStyles: true, fluidRules: true,
		} );
		expect( comparison.equal ).toBe( true );
		// The member's content really is transplanted, not a copy of the representative.
		expect( derivation.html ).toContain( '<h1 class="post-title">post-2</h1>' );
	} );

	it( 'rejects a member whose cluster key drifted (the fingerprint is what admits derivation)', () => {
		// Same skeleton, different page-local style: a stale or A/B-variant member
		// must never ship as derived.
		const drift = serverDocument( 'post-2', undefined, '<style>.entry-content{column-gap:2em}</style>' );
		const derivation = deriveMemberDocument( { ...representative, memberServerHtml: drift } );
		expect( derivation ).toEqual( {
			ok: false,
			gate: { code: 'cluster_key_mismatch', reason: 'the member server document no longer matches its cluster fingerprint' },
		} );
	} );

	it( 'escalates a subtree slot carrying an unobserved event handler', () => {
		// A repeated sibling collapses in the skeleton, so the key still matches;
		// the slot's member HTML carries an onclick handler the capture never ran.
		const runtime = serverDocument( 'post-2' ).replace( '</figure></div>', '</figure><figure class="wp-block-image" onclick="steal()"><img src="/img/figure-post-2-b.jpg" alt="Figure" width="1200" height="675"></figure></div>' );
		const derivation = deriveMemberDocument( { ...representative, memberServerHtml: runtime } );
		expect( derivation ).toMatchObject( { ok: false, gate: { code: 'runtime_slot_content' } } );
	} );

	it( 'escalates when a slot has no anchor in the processed document', () => {
		const processed = representative.repProcessedHtml.replace( '<p>Second paragraph.</p>', '' );
		const derivation = deriveMemberDocument( { ...representative, repProcessedHtml: processed, memberServerHtml: serverDocument( 'post-2' ) } );
		expect( derivation ).toMatchObject( { ok: false, gate: { code: 'slot_anchor_unmapped' } } );
	} );

	it( 'keeps unobserved data-* media swapped by a runtime out of a derived document', () => {
		// A subtree slot whose replacement carries a runtime-owned data-src attr
		// is counted unobserved in the receipt: the derived document cannot
		// claim that rendition was ever seen.
		const derivation = deriveMemberDocument( { ...representative, memberServerHtml: serverDocument( 'post-2' ).replace( 'loading="lazy"', 'loading="lazy" data-src="/img/swap.jpg"' ) } );
		expect( derivation ).toMatchObject( { ok: true, unobservedSlots: 0 } );
	} );

	it( 'writes the receipt next to website/', () => {
		const directory = mkdtempSync( join( tmpdir(), 'template-clusters-' ) );
		const path = writeTemplateClusters( directory, {
			schema: TEMPLATE_CLUSTERS_SCHEMA, fingerprint: { version: 1 }, sourceUrl: BASE,
			derivedCount: 1, escalatedCount: 0, unavailableCount: 0,
			clusters: [ { id: 't1', key: 'k', representative: `${ BASE }/post-1/`, derived: [ { url: `${ BASE }/post-2/`, slots: 3, subtreeSlots: 0 } ], escalated: [], unavailable: [] } ],
		} );
		expect( existsSync( join( directory, 'template-clusters.json' ) ) ).toBe( true );
		expect( JSON.parse( readFileSync( path, 'utf8' ) as string ).schema ).toBe( 'data-liberation-agent/template-clusters/v1' );
	} );
} );

describe( 'transplant keeps inline structure (#784)', () => {
	const page = ( title: string, extra = '' ) =>
		`<html><head><title>${ title }</title></head><body><main><h1>${ title }</h1><p>${ title } by <a href="/author">Ann</a>${ extra }</p></main></body></html>`;
	const derive = ( member: string ) => deriveMemberDocument( { repServerHtml: page( 'One' ), repProcessedHtml: page( 'One' ), memberServerHtml: member, baseUrl: 'https://fixture.test/' } );

	it( 'replaces only the own text of an element whose words differ, keeping its links', () => {
		const result = derive( page( 'Two' ) );
		expect( result.ok && result.html ).toContain( '<p>Two by <a href="/author">Ann</a></p>' );
	} );

	it( 'replaces mixed content in full, text included, when its layout differs', () => {
		const result = derive( page( 'Two', ' and <b>Bo</b> too' ) );
		expect( result.ok && result.html ).toContain( '<p>Two by <a href="/author">Ann</a> and <b>Bo</b> too</p>' );
	} );
} );

