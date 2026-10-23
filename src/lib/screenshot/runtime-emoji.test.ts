import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
	isRuntimeEmojiReplacementImage,
	restoreEmojiText,
	RUNTIME_EMOJI_PREDICATE_SOURCE,
	RUNTIME_EMOJI_RESTORE_SOURCE,
	type EmojiImageAttributes,
} from './runtime-emoji.js';

// The exact markup from the issue: what WordPress core's emoji script
// (wp-emoji.js + Twemoji) leaves in the live DOM.
const HOT_FACE_SVG = 'https://s.w.org/images/core/emoji/17.0.2/svg/1f975.svg';
const HOT_FACE_IMG =
	`<img draggable="false" role="img" class="emoji" alt="🥵" src="${ HOT_FACE_SVG }">`;
const FAMILY_SVG = 'https://s.w.org/images/core/emoji/17.0.2/svg/1f468-200d-1f469-200d-1f466-200d-1f466.svg';
const FAMILY_IMG =
	`<img draggable="false" role="img" class="emoji" alt="👨‍👩‍👦‍👦" src="${ FAMILY_SVG }">`;
const FIRE_PNG = 'https://s.w.org/images/core/emoji/14.0.0/72x72/1f525.png';
const FIRE_IMG =
	`<img draggable="false" role="img" class="emoji" alt="🔥" src="${ FIRE_PNG }">`;

const twemoji = ( overrides: Partial< EmojiImageAttributes > = {} ): EmojiImageAttributes => ( {
	className: 'emoji',
	draggable: 'false',
	role: 'img',
	alt: '🥵',
	src: HOT_FACE_SVG,
	...overrides,
} );

/** Parses a fixture the way a page would, into something the rewrite accepts. */
function documentOf( bodyHtml: string ): { dom: JSDOM; doc: Document } {
	const dom = new JSDOM( `<!doctype html><html><body>${ bodyHtml }</body></html>` );
	return { dom, doc: dom.window.document as unknown as Document };
}

describe( 'isRuntimeEmojiReplacementImage', () => {
	it( 'accepts the exact markup the issue quotes', () => {
		expect( isRuntimeEmojiReplacementImage( twemoji() ) ).toBe( true );
	} );

	it( 'accepts the ZWJ family sequence from core 17.0.2 svg', () => {
		expect( isRuntimeEmojiReplacementImage( twemoji( {
			alt: '👨‍👩‍👦‍👦',
			src: FAMILY_SVG,
		} ) ) ).toBe( true );
	} );

	it( 'accepts a 72x72 png variant', () => {
		expect( isRuntimeEmojiReplacementImage( twemoji( {
			alt: '🔥',
			src: FIRE_PNG,
		} ) ) ).toBe( true );
	} );

	it( 'accepts the other Twemoji / core asset layouts and keycap, flag and tag-sequence emoji', () => {
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '1️⃣', src: 'https://s.w.org/images/core/emoji/15.0.1/svg/31-fe0f-20e3.svg' } ) ) ).toBe( true );
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '🇺🇸', src: 'https://s.w.org/images/core/emoji/14.0.0/72x72/1f1fa-1f1f8.png' } ) ) ).toBe( true );
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '🏴󠁧󠁢󠁳󠁣󠁴󠁿', src: 'https://s.w.org/images/core/emoji/15.0.1/svg/1f3f4-e0067-e0062-7363-6f74-7f.svg' } ) ) ).toBe( true );
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '😀', src: 'https://twemoji.maxcdn.com/v/latest/svg/1f600.svg' } ) ) ).toBe( true );
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '😀', src: 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f600.png' } ) ) ).toBe( true );
		// A relative src resolves to the same path shape; a query string is ignored.
		expect( isRuntimeEmojiReplacementImage( twemoji( { src: '/wp-includes/images/core/emoji/16.0.1/svg/1f4af.svg' } ) ) ).toBe( true );
		expect( isRuntimeEmojiReplacementImage( twemoji( { src: `${ HOT_FACE_SVG }?ver=6.5` } ) ) ).toBe( true );
		expect( isRuntimeEmojiReplacementImage( twemoji( { className: 'emoji other' } ) ) ).toBe( true );
		// Several emoji and nothing else.
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '🥵🔥' } ) ) ).toBe( true );
	} );

	it( 'rejects a missing or wrong class', () => {
		expect( isRuntimeEmojiReplacementImage( twemoji( { className: '' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { className: 'emojijs' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { className: 'Emoji' } ) ) ).toBe( false );
	} );

	it( 'rejects images lacking Twemoji\'s draggable and role', () => {
		expect( isRuntimeEmojiReplacementImage( twemoji( { draggable: null } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { draggable: 'true' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { role: null } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { role: 'presentation' } ) ) ).toBe( false );
	} );

	it( 'rejects non-emoji alt text', () => {
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: null } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: 'Hot' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '🥵!' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '🥵 ' } ) ) ).toBe( false );
		// A bare digit is not a keycap, a lone regional indicator is not a flag,
		// and a bare ZWJ is not an emoji.
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '1' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '🇺' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { alt: '‍' } ) ) ).toBe( false );
	} );

	it( 'rejects a non-emoji src, including an authored image with an emoji alt', () => {
		expect( isRuntimeEmojiReplacementImage( twemoji( { src: null } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { src: '' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { src: '/wp-content/uploads/2024/07/hot-face.png' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { src: 'https://example.com/images/logo.svg' } ) ) ).toBe( false );
		expect( isRuntimeEmojiReplacementImage( twemoji( { src: 'https://s.w.org/images/core/emoji/17.0.2/svg/1f975.gif' } ) ) ).toBe( false );
	} );
} );

describe( 'restoreEmojiText', () => {
	it( 'restores the plain emoji text inside <code>, an h2 and a paragraph, ZWJ sequence included', () => {
		const { doc } = documentOf(
			`<p>Running hot: <code>temp ${ HOT_FACE_IMG } today</code> outside</p>` +
			`<h2>${ FAMILY_IMG } household</h2>` +
			`<p>Feel ${ HOT_FACE_IMG } about it</p>`
		);
		expect( restoreEmojiText( doc ) ).toBe( 3 );
		expect( doc.querySelector( 'code' )!.textContent ).toBe( 'temp 🥵 today' );
		expect( doc.querySelector( 'h2' )!.textContent ).toBe( '👨‍👩‍👦‍👦 household' );
		expect( doc.querySelectorAll( 'p' )[ 1 ]!.textContent ).toBe( 'Feel 🥵 about it' );
		expect( doc.querySelector( 'img' ) ).toBeNull();
	} );

	it( 'merges the restored text back into the single run the source authored', () => {
		const { doc } = documentOf( `<h2><code>"My ${ FAMILY_IMG } is fun"</code></h2>` );
		expect( restoreEmojiText( doc ) ).toBe( 1 );
		const code = doc.querySelector( 'code' )!;
		expect( code.childNodes ).toHaveLength( 1 );
		expect( code.innerHTML ).toBe( '"My 👨‍👩‍👦‍👦 is fun"' );
	} );

	it( 'restores a 72x72 png variant', () => {
		const { doc } = documentOf( `<p>Lit ${ FIRE_IMG }</p>` );
		expect( restoreEmojiText( doc ) ).toBe( 1 );
		expect( doc.querySelector( 'p' )!.textContent ).toBe( 'Lit 🔥' );
	} );

	it( 'leaves authored images untouched', () => {
		const { doc } = documentOf(
			// Emoji alt but a non-emoji src, and none of Twemoji's attributes.
			`<p><img class="emoji" alt="🥵" src="/wp-content/uploads/2024/07/hot-face.png"> stays</p>` +
			// Twemoji shape but a non-emoji alt.
			`<p><img draggable="false" role="img" class="emoji" alt="Hot" src="${ HOT_FACE_SVG }"> stays</p>` +
			// An ordinary content image.
			`<p><img class="photo" alt="Portrait" src="/images/portrait.png"> stays</p>`
		);
		expect( restoreEmojiText( doc ) ).toBe( 0 );
		expect( doc.querySelectorAll( 'img' ).length ).toBe( 3 );
	} );

	it( 'marks each replacement in the exact shape wp-emoji\'s observer skips', async () => {
		// wp-emoji's MutationObserver turns added text back into an image —
		// unless one Text node replaces one image whose data-error is
		// load-failed and whose alt equals the text. The restore must take
		// exactly that path, or serialization races the observer and loses.
		const { dom, doc } = documentOf( `<p>a${ HOT_FACE_IMG }b</p>` );
		const records: MutationRecord[] = [];
		const observer = new dom.window.MutationObserver( ( list ) => records.push( ...list ) );
		observer.observe( doc.body, { childList: true, subtree: true } );
		expect( restoreEmojiText( doc ) ).toBe( 1 );
		// Mutation records are delivered asynchronously.
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		observer.disconnect();
		// The replacement is the first record; merging the restored text into
		// its neighbours afterwards only removes nodes, so it gives the
		// observer nothing to parse.
		expect( records[ 0 ]!.addedNodes ).toHaveLength( 1 );
		expect( records[ 0 ]!.removedNodes ).toHaveLength( 1 );
		for ( const record of records.slice( 1 ) ) expect( record.addedNodes ).toHaveLength( 0 );
		const added = records[ 0 ]!.addedNodes[ 0 ]!;
		const removed = records[ 0 ]!.removedNodes[ 0 ]!;
		expect( added.nodeType ).toBe( dom.window.Node.TEXT_NODE );
		expect( removed instanceof dom.window.HTMLImageElement ).toBe( true );
		expect( added.textContent ).toBe( ( removed as HTMLImageElement ).alt );
		expect( ( removed as HTMLImageElement ).getAttribute( 'data-error' ) ).toBe( 'load-failed' );
		// The marker rides the removed element; it never reaches the markup.
		expect( doc.body.innerHTML ).not.toContain( 'data-error' );
		expect( doc.querySelector( 'p' )!.childNodes ).toHaveLength( 1 );
	} );
} );

describe( 'RUNTIME_EMOJI_PREDICATE_SOURCE / RUNTIME_EMOJI_RESTORE_SOURCE', () => {
	const CASES: EmojiImageAttributes[] = [
		twemoji(),
		twemoji( { alt: '👨‍👩‍👦‍👦', src: FAMILY_SVG } ),
		twemoji( { alt: '🔥', src: FIRE_PNG } ),
		twemoji( { className: '' } ),
		twemoji( { alt: 'Hot' } ),
		twemoji( { src: '/wp-content/uploads/2024/07/hot-face.png' } ),
		twemoji( { draggable: null } ),
	];

	it( 'builds a predicate and rewrite that agree with the Node exports', () => {
		const predicate = new Function( 'return (' + RUNTIME_EMOJI_PREDICATE_SOURCE.factorySrc + ')' )()() as typeof isRuntimeEmojiReplacementImage;
		for ( const attrs of CASES ) {
			expect( predicate( attrs ) ).toBe( isRuntimeEmojiReplacementImage( attrs ) );
		}
		const restore = new Function( 'return (' + RUNTIME_EMOJI_RESTORE_SOURCE.factorySrc + ')' )()( predicate ) as typeof restoreEmojiText;
		const { doc } = documentOf( `<p><code>${ FAMILY_IMG }${ HOT_FACE_IMG }</code></p>` );
		expect( restore( doc ) ).toBe( 2 );
		expect( doc.querySelector( 'code' )!.textContent ).toBe( '👨‍👩‍👦‍👦🥵' );
	} );

	// The browser receives these factories as text. Build them the way the
	// shipped runtime bundle does (minified) and run them with no module scope
	// around them: any helper they reach by a module-level name is then
	// undefined, which is how every page of a matching site failed to capture
	// in the bundle.
	it( 'restores from a minified build with no module scope', async () => {
		const { build } = await import( 'esbuild' );
		const { fileURLToPath } = await import( 'node:url' );
		const result = await build( {
			entryPoints: [ fileURLToPath( new URL( './runtime-emoji.ts', import.meta.url ) ) ],
			bundle: true,
			minify: true,
			format: 'esm',
			platform: 'node',
			write: false,
		} );
		const moduleUrl = `data:text/javascript;base64,${ Buffer.from( result.outputFiles[ 0 ]!.text ).toString( 'base64' ) }`;
		const minified = await import( moduleUrl );
		const predicate = new Function( 'return (' + minified.RUNTIME_EMOJI_PREDICATE_SOURCE.factorySrc + ')' )()() as typeof isRuntimeEmojiReplacementImage;
		for ( const attrs of CASES ) {
			expect( predicate( attrs ) ).toBe( isRuntimeEmojiReplacementImage( attrs ) );
		}
		const restore = new Function( 'return (' + minified.RUNTIME_EMOJI_RESTORE_SOURCE.factorySrc + ')' )()( predicate ) as typeof restoreEmojiText;
		const { doc } = documentOf( `<h2>${ FAMILY_IMG }</h2>` );
		expect( restore( doc ) ).toBe( 1 );
		expect( doc.querySelector( 'h2' )!.textContent ).toBe( '👨‍👩‍👦‍👦' );
	} );
} );
