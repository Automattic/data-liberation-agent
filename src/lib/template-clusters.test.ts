import { describe, expect, it } from 'vitest';
import { compareDerivedWithCapture, deriveMemberDocument, TEMPLATE_CLUSTERS_SCHEMA, writeTemplateClusters } from './template-clusters.js';
import { TEMPLATE_FINGERPRINT_VERSION, templateFingerprint } from './template-groups.js';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('ignores only stylesheet links absent from both server documents', () => {
	const page = (links: string[], inline = 'body { color: black }') => `<html><head>${links.map(href => `<link rel="stylesheet" href="${href}">`).join('')}<style>${inline}</style></head><body><p>Same member</p></body></html>`;
	const context = { baseUrl: 'https://fixture.example/post', repServerHtml: page(['/template.css']), memberServerHtml: page(['/template.css', '/member.css']) };
	const derivedHtml = page(['/template.css', '/member.css', '/runtime-dialog.css']);
	const realHtml = page(['/template.css', '/member.css']);
	expect(compareDerivedWithCapture({ ...context, derivedHtml, realHtml }).equal).toBe(true);
	expect(compareDerivedWithCapture({ ...context, derivedHtml: realHtml, realHtml: derivedHtml }).equal).toBe(true);
	for (const links of [['/member.css'], ['/template.css']]) {
		expect(compareDerivedWithCapture({ ...context, derivedHtml, realHtml: page(links) }).checks.headStyles).toBe(false);
	}
	expect(compareDerivedWithCapture({ ...context, derivedHtml, realHtml: page(['/template.css', '/member.css'], 'body { color: red }') }).checks.headStyles).toBe(false);
	expect(compareDerivedWithCapture({ derivedHtml, realHtml, baseUrl: context.baseUrl }).checks.headStyles).toBe(false);
});

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

	it( 'transplants differing body style text with the member block id (#1796)', () => {
		const page = ( id: string ) => serverDocument( 'Post', `<div id="block-${ id }"><p>Block ${ id }</p><style>#block-${ id } { color: red }</style></div>` );
		const repServerHtml = page( 'A' );
		const memberServerHtml = page( 'B' );
		const result = deriveMemberDocument( {
			repServerHtml,
			repProcessedHtml: repServerHtml,
			memberServerHtml,
			baseUrl: BASE,
			// Admit per-member block selectors without changing template identity.
			styleNormalization: { pageStyles: styles => styles.map( style => style.text.replace( /#block-[AB]/g, '#block-slot' ) ).join( '\n' ) },
		} );
		expect( result.ok ).toBe( true );
		if ( ! result.ok ) return;
		expect( result.html ).toContain( '<div id="block-B">' );
		expect( result.html ).toContain( '<style>#block-B { color: red }</style>' );
		expect( result.html ).not.toContain( '#block-A' );
		expect( compareDerivedWithCapture( { derivedHtml: result.html, realHtml: memberServerHtml, baseUrl: BASE } ).checks.headStyles ).toBe( true );
	} );

	it( 'pairs head metadata by identity wherever the parser leaves it (Blogger)', () => {
		// Blogger heads carry markup that closes <head> early, so the HTML parser
		// leaves title and social metadata in <body>, in both captures.
		const blogger = ( slug: string, extra = '' ): string => `<!doctype html>
<html><head><script>/* widgets */</script><div hidden></div><title>${ slug }</title>
<meta property="og:title" content="${ slug }"><meta property="og:url" content="${ BASE }/2023/02/${ slug }.html">
<meta name="og:description" content="Review of ${ slug }"><meta name="twitter:title" content="${ slug }">${ extra }</head>
<body>${ entry( [ 'First paragraph.', 'Second paragraph.' ], slug ) }</body></html>`;
		const representativeHtml = blogger( 'kavango', '<meta property="og:image" content="/img/kavango.jpg">' );
		const derivation = deriveMemberDocument( { repServerHtml: representativeHtml, repProcessedHtml: representativeHtml, memberServerHtml: blogger( 'mini-rogue', '<meta name="twitter:image" content="/img/mini-rogue.jpg">' ), baseUrl: BASE } );
		expect( derivation.ok ).toBe( true );
		if ( ! derivation.ok ) return;
		expect( derivation.html ).not.toContain( 'kavango' );
		for ( const expected of [ '<title>mini-rogue</title>', `content="${ BASE }/2023/02/mini-rogue.html"`, 'content="Review of mini-rogue"', '<meta name="twitter:title" content="mini-rogue">', '<meta name="twitter:image" content="/img/mini-rogue.jpg">' ] ) {
			expect( derivation.html ).toContain( expected );
		}
	} );

	it( 'transplants responsive image attributes and detects stale srcsets (#1475)', () => {
		const page = ( name: string, width: number, height: number ) => serverDocument( 'Post', `<div width="${ width }" height="${ height }"><picture><source srcset="/img/${ name }.webp 1x" sizes="${ width }px" width="${ width }" height="${ height }"><img src="/img/${ name }.jpg" srcset="/img/${ name }.jpg ${ width }w" sizes="${ width }px" width="${ width }" height="${ height }"></picture></div>` );
		const repServerHtml = page( 'representative', 1672, 941 );
		const memberServerHtml = page( 'member', 1536, 1024 );
		const result = deriveMemberDocument( { repServerHtml, repProcessedHtml: repServerHtml, memberServerHtml, baseUrl: BASE } );
		expect( result.ok ).toBe( true );
		if ( ! result.ok ) return;
		expect.soft( result.html ).toContain( 'srcset="/img/member.jpg 1536w"' );
		expect.soft( result.html ).toContain( 'sizes="1536px" width="1536" height="1024"' );
		expect.soft( result.html ).toContain( '<source srcset="/img/member.webp 1x" sizes="1536px" width="1536" height="1024">' );
		// Dimensions on unrelated elements are not content slots.
		expect( result.html ).toContain( '<div width="1672" height="941">' );
		const compareImages = ( derivedHtml: string, realHtml = memberServerHtml ) => compareDerivedWithCapture( { derivedHtml, realHtml, baseUrl: BASE } ).checks.images;
		expect.soft( compareImages( memberServerHtml.replace( 'srcset="/img/member.jpg 1536w"', 'srcset="/img/representative.jpg 1672w"' ) ) ).toBe( false );
		expect.soft( compareImages( memberServerHtml.replace( 'member.webp', 'representative.webp' ) ) ).toBe( false );
		expect( compareImages( result.html ) ).toBe( true );
		expect( compareImages( memberServerHtml, memberServerHtml.replaceAll( '/img/', `${ BASE }/img/` ) ) ).toBe( true );
	} );

	it( 'derives member text and body classes when only volatile post IDs differ (#1455)', () => {
		const page = ( id: number, text: string ) => `<html><head><title>Post</title></head><body class="postid-${ id }"><article><p>${ text }</p></article><script>window.siteReady = true;</script></body></html>`;
		const repServerHtml = page( 750, 'Representative article' );
		const result = deriveMemberDocument( {
			repServerHtml,
			// Capture keeps a runtime-added body class; the member keeps it too.
			repProcessedHtml: repServerHtml.replace( 'class="postid-750"', 'class="postid-750 runtime-ready"' ),
			memberServerHtml: page( 407, 'Member article' ),
			baseUrl: BASE,
		} );
		expect( result.ok ).toBe( true );
		if ( ! result.ok ) return;
		expect( result.html ).toContain( '<p>Member article</p>' );
		expect( result.html ).toContain( '<body class="runtime-ready postid-407">' );
	} );

	it( 'derives a body id attribute slot despite capture-added body text (#1776)', () => {
		const page = ( id: string, text: string ) => `<html><head><title>Post</title></head><body id="item-${ id }"><main><p>${ text }</p></main></body></html>`;
		const repServerHtml = page( 'one', 'Representative article' );
		const result = deriveMemberDocument( {
			repServerHtml,
			repProcessedHtml: repServerHtml.replace( '</body>', '<aside>Runtime-added chrome</aside></body>' ),
			memberServerHtml: page( 'two', 'Member article' ),
			baseUrl: BASE,
		} );
		expect( result.ok ).toBe( true );
		if ( ! result.ok ) return;
		expect( result.stats ).toEqual( { slots: 2, subtreeSlots: 0 } );
		expect( result.html ).toContain( '<body id="item-two">' );
		expect( result.html ).toContain( '<p>Member article</p>' );
		expect( result.html ).toContain( '<aside>Runtime-added chrome</aside>' );
	} );

	it.each( [
		[ 'text', '<p>Member article</p>' ],
		[ 'subtree', '<p>Member article</p><p>Another paragraph</p>' ],
	] )( 'still rejects a %s slot whose anchor text capture rewrote (#1776)', ( _kind, memberContent ) => {
		const page = ( content: string ) => `<html><head><title>Post</title></head><body><main id="article">${ content }</main></body></html>`;
		const result = deriveMemberDocument( {
			repServerHtml: page( '<p>Representative article</p>' ),
			repProcessedHtml: page( '<p>Runtime-rewritten article</p>' ),
			memberServerHtml: page( memberContent ),
			baseUrl: BASE,
		} );
		expect( result ).toMatchObject( { ok: false, gate: { code: 'slot_anchor_unmapped' } } );
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
		const processed = representative.repProcessedHtml.replace( /<figure[\s\S]*?<\/figure>/, '' );
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
			schema: TEMPLATE_CLUSTERS_SCHEMA, fingerprint: { version: TEMPLATE_FINGERPRINT_VERSION }, sourceUrl: BASE,
			derivedCount: 1, escalatedCount: 0, unavailableCount: 0,
			clusters: [ { id: 't1', key: 'k', representative: `${ BASE }/post-1/`, derived: [ { url: `${ BASE }/post-2/`, slots: 3, subtreeSlots: 0 } ], escalated: [], unavailable: [] } ],
		} );
		expect( existsSync( join( directory, 'template-clusters.json' ) ) ).toBe( true );
		expect( JSON.parse( readFileSync( path, 'utf8' ) as string ).schema ).toBe( 'data-liberation-agent/template-clusters/v1' );
	} );
} );

describe( 'server-empty hydration mounts (#1775)', () => {
	// Squarespace-style comments: the representative has a per-item mount the
	// runtime fills after load; the member has comments off, so the container
	// becomes a subtree slot.
	const page = ( title: string, comments?: string ) => `<html><head><title>Post</title></head><body><article id="article-${ title }"><div class="content"><p>${ title }</p></div><section class="comments"><div id="comments-content" class="comments-content">${ comments === undefined ? '' : `<div id="comments-${ title }" class="mount">${ comments }</div>` }</div></section></article></body></html>`;
	const hydrated = '<p>Comments (0)</p><button>Post Comment</button>';
	const derive = ( captured: string ) => deriveMemberDocument( {
		repServerHtml: page( 'One', '' ), repProcessedHtml: captured,
		memberServerHtml: page( 'Two' ), baseUrl: BASE,
	} );

	it( 'maps a slot nested in a runtime-filled mount', () => {
		const result = derive( page( 'One', hydrated ) );
		expect( result.ok, JSON.stringify( result ) ).toBe( true );
		if ( ! result.ok ) return;
		expect( result.html ).toContain( '<p>Two</p>' );
		expect( compareDerivedWithCapture( { derivedHtml: result.html, realHtml: page( 'Two' ), baseUrl: BASE } ).equal ).toBe( true );
		expect( compareDerivedWithCapture( { derivedHtml: result.html, realHtml: page( 'Two', 'Different comments' ), baseUrl: BASE } ).equal ).toBe( false );
	} );

	it( 'still rejects rewritten server text alongside a hydrated mount', () => {
		const result = derive( page( 'One', hydrated ).replace( '<p>One</p>', '<p>Rewritten</p>' ) );
		expect( result ).toMatchObject( { ok: false, gate: { code: 'slot_anchor_unmapped' } } );
	} );
} );

describe( 'head slots pair head elements only (#784)', () => {
	it( 'keeps body titles a malformed template emits after </html>, and titles the head from the first one', () => {
		// Blogger templates can write `<title>` elements after `</html>`. The
		// server document then has no head title, while capture keeps one in
		// the head (`document.title`) plus the body copies.
		const server = ( title: string ) => `<html><head></head><body><h1>${ title }</h1></body></html>\n<title>${ title } - Blog</title><title>Blog</title>`;
		const processed = ( title: string ) => `<html><head><title>${ title } - Blog</title></head><body><h1>${ title }</h1><title>${ title } - Blog</title><title>Blog</title></body></html>`;
		const result = deriveMemberDocument( { repServerHtml: server( 'One' ), repProcessedHtml: processed( 'One' ), memberServerHtml: server( 'Two' ), baseUrl: BASE } );
		expect( result.ok ).toBe( true );
		if ( ! result.ok ) return;
		expect( compareDerivedWithCapture( { derivedHtml: result.html, realHtml: processed( 'Two' ), baseUrl: BASE } ).checks.text ).toBe( true );
		expect( result.html ).toContain( '<head><title>Two - Blog</title></head>' );
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


describe( 'slots anchor on element identity, not position (#784)', () => {
	// Server documents (`H_R`, `H_M`): the post body sits under an id'd
	// component; the member differs in its words only.
	const server = ( title: string, words: string ) => `<html><head><title>Post</title></head><body>
<header id="site-header"><nav><a href="/">Home</a></nav></header>
<main><div class="shell"><section id="post-body" data-testid="post"><h1>${ title }</h1><p>${ words } with <a href="/author">a link</a> and <b>bold text</b>.</p></section></div></main>
<footer><p>Footer</p></footer></body></html>`;
	// The captured document (`D_R`): a runtime wrapped the page in extra
	// containers, moved the footer before main, injected a banner, and capture
	// annotated source elements in place. Only the ids survive unchanged.
	const captured = ( title: string, words: string ) => `<html><head><title>Post</title></head><body>
<div class="runtime-root"><div class="runtime-banner"><p>Injected</p></div>
<footer><p>Footer</p></footer>
<div class="runtime-page"><header id="site-header"><nav><a href="/">Home</a></nav></header>
<main class="hydrated"><div class="shell" data-blocks-engine-capture-geometry-id="desktop-wrapper-1"><div class="extra-wrapper"><section id="post-body" data-testid="post" data-blocks-engine-capture-geometry-id="desktop-target-1"><h1 data-blocks-engine-capture-geometry-id="desktop-target-2">${ title }</h1><p>${ words } with <a href="/author">a link</a> and <b>bold text</b>.</p></section></div></div></main></div></div></body></html>`;
	const BASE_URL = 'https://fixture.test/';

	it( 'derives across extra wrappers and reordered siblings, keeping inline links and bold text', () => {
		const result = deriveMemberDocument( {
			repServerHtml: server( 'First post', 'Original words' ),
			repProcessedHtml: captured( 'First post', 'Original words' ),
			memberServerHtml: server( 'Second post', 'Member words' ),
			baseUrl: BASE_URL,
		} );
		expect( result.ok ).toBe( true );
		if ( ! result.ok ) return;
		expect( result.html ).toContain( '<h1 data-blocks-engine-capture-geometry-id="desktop-target-2">Second post</h1>' );
		expect( result.html ).toContain( '<p>Member words with <a href="/author">a link</a> and <b>bold text</b>.</p>' );
		expect( result.html ).not.toContain( 'Original words' );
		// The runtime's structure is the representative's capture, untouched.
		expect( result.html ).toContain( '<div class="runtime-banner"><p>Injected</p></div>' );
	} );

	it( 'resolves an unanchored slot past runtime-inserted siblings and classes, and retitles body title copies', () => {
		const page = ( title: string ) => `<html><head><title>${ title } | Site</title></head><body><div class="wrap"><div class="social">Social</div><div class="banner"><h1>${ title }</h1></div></div></body></html>`;
		// The runtime prepends a sibling, adds a class and copies document.title into the body.
		const captured = ( title: string ) => `<html><head><title>${ title } | Site</title></head><body><div class="wrap"><div class="cookie-mount"></div><div class="social">Social</div><div class="banner loaded"><h1>${ title }</h1></div></div><title>${ title } | Site</title></body></html>`;
		const result = deriveMemberDocument( { repServerHtml: page( 'One' ), repProcessedHtml: captured( 'One' ), memberServerHtml: page( 'Two' ), baseUrl: BASE_URL } );
		expect( result.ok ).toBe( true );
		if ( ! result.ok ) return;
		expect( compareDerivedWithCapture( { derivedHtml: result.html, realHtml: captured( 'Two' ), baseUrl: BASE_URL } ).equal ).toBe( true );
	} );

	it( 'falls back to data-testid when the anchor has no id', () => {
		const withoutId = ( html: string ) => html.replace( ' id="post-body"', '' );
		const result = deriveMemberDocument( {
			repServerHtml: withoutId( server( 'First post', 'Original words' ) ),
			repProcessedHtml: withoutId( captured( 'First post', 'Original words' ) ),
			memberServerHtml: withoutId( server( 'Second post', 'Member words' ) ),
			baseUrl: BASE_URL,
		} );
		expect( result.ok && result.html ).toContain( '<p>Member words with <a href="/author">a link</a> and <b>bold text</b>.</p>' );
	} );

	it( 'escalates a slot whose anchored text the runtime rewrote after load', () => {
		const result = deriveMemberDocument( {
			repServerHtml: server( 'First post', 'Original words' ),
			// The runtime replaced the server's words: transplanting the member's
			// server text over it would mix two documents.
			repProcessedHtml: captured( 'First post', 'Rewritten words' ),
			memberServerHtml: server( 'Second post', 'Member words' ),
			baseUrl: BASE_URL,
		} );
		expect( result.ok ).toBe( false );
		if ( result.ok ) return;
		expect( result.gate.code ).toBe( 'slot_anchor_unmapped' );
		expect( result.gate.reason ).toBe( 'slot at [id="post-body"]/1 carries different text in the representative\'s captured document than in its server document' );
	} );

	it( 'escalates when the anchor id is missing from the captured document', () => {
		const result = deriveMemberDocument( {
			repServerHtml: server( 'First post', 'Original words' ),
			repProcessedHtml: captured( 'First post', 'Original words' ).replace( ' id="post-body"', ' id="renamed"' ).replace( ' data-testid="post"', '' ),
			memberServerHtml: server( 'Second post', 'Member words' ),
			baseUrl: BASE_URL,
		} );
		expect( result ).toMatchObject( { ok: false, gate: { code: 'slot_anchor_unmapped' } } );
		if ( result.ok ) return;
		expect( result.gate.reason ).toContain( 'has no matching anchor' );
	} );
} );

describe( 'verification compares rendered text (#784)', () => {
	// Builder viewers inline per-request values (render timestamps, nonces) in
	// body scripts, so two captures of the same content never share them.
	const page = ( renderTimeStamp: number, body: string ) =>
		`<html><head></head><body><script>var ssrInfo = {"renderTimeStamp":${ renderTimeStamp }}</script><style>.a{color:red}</style><main><p>${ body }</p></main></body></html>`;

	it( 'ignores per-request script values', () => {
		const comparison = compareDerivedWithCapture( { derivedHtml: page( 1791708655133, 'Same post' ), realHtml: page( 1791709009600, 'Same post' ), baseUrl: BASE } );
		expect( comparison.checks.text ).toBe( true );
	} );

	it( 'still fails on a rendered text difference', () => {
		const comparison = compareDerivedWithCapture( { derivedHtml: page( 1, '260 views' ), realHtml: page( 1, '87 views' ), baseUrl: BASE } );
		expect( comparison.checks.text ).toBe( false );
	} );
} );
