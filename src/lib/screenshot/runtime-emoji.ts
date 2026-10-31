/**
 * Runtime emoji replacement restoration (#954).
 *
 * WordPress core's emoji script (`wp-emoji.js` + Twemoji) replaces emoji
 * characters in the live DOM with images:
 *
 *   <img draggable="false" role="img" class="emoji" alt="🥵"
 *        src="https://s.w.org/images/core/emoji/17.0.2/svg/1f975.svg">
 *
 * DLA serializes the rendered DOM, so the capture would carry those images
 * instead of the authored text — including inside `<code>`, headings and post
 * titles, where the destination cannot keep them native and they degrade into
 * `core/html`. Each replacement image goes back to its `alt` text before
 * serialization; the imported WordPress site runs core's emoji script itself,
 * so the rendered result matches the source.
 *
 * The match is strict, because only an image that is unambiguously a runtime
 * emoji replacement may be rewritten: the class token `emoji`, Twemoji's
 * `draggable="false"` / `role="img"`, an `alt` consisting solely of emoji
 * graphemes (Extended_Pictographic bases with presentation selectors,
 * skin-tone modifiers, ZWJ joins, keycap and flag machinery), and a Twemoji /
 * core emoji asset `src`. Authored images — a non-emoji src, a non-emoji alt,
 * a missing class — are untouched.
 *
 * wp-emoji installs a MutationObserver that re-parses added nodes and would
 * turn the restored text straight back into an image. Its own escape hatch —
 * the path its `onerror` takes when an image fails to load — is a single Text
 * node replacing an `<img>` whose `data-error` is `load-failed`; the restore
 * takes exactly that path, so the observer leaves the text in place. The
 * attribute sits on the removed element and never serializes.
 *
 * Everything inside the factories below is self-contained (see
 * css-shorthand-repair.ts): `toString()` of each is complete on its own, the
 * browser copies run the same code as the Node exports, and a minifier renames
 * helpers consistently within each factory. The restore factory takes the
 * predicate as its argument, so browser and Node compose the same two pieces.
 */
import type { Page } from 'playwright';
import type { ProfileDiagnostic } from './manifest-queue.js';

/** The attributes of one `<img>`, as `getAttribute` reports them. */
export interface EmojiImageAttributes {
	className: string;
	draggable: string | null;
	role: string | null;
	alt: string | null;
	src: string | null;
}

/**
 * Builds the replacement predicate. Every helper lives inside this one
 * function, so `toString()` of it is complete on its own: the browser copy
 * (injected through `RUNTIME_EMOJI_PREDICATE_SOURCE`) and the Node export run
 * the same code, and a minifier renames the helpers consistently within it.
 * Helpers kept at module level would be reached by their minified module
 * names, which do not exist in the page.
 */
function createRuntimeEmojiPredicate(): ( attrs: EmojiImageAttributes ) => boolean {
	// Alt text that is nothing but emoji: keycap sequences (1️⃣), regional
	// indicator pairs (🇺🇸), and pictographic bases followed by presentation
	// selectors, skin-tone modifiers, tag characters (subdivision flags) and
	// ZWJ joins (👨‍👩‍👦‍👦). A bare digit, letter, ZWJ or lone regional
	// indicator matches nothing, and neither does emoji mixed with any other
	// character.
	const EMOJI_ONLY_TEXT =
		/^(?:[0-9#*]\uFE0F?\u20E3|[\u{1F1E6}-\u{1F1FF}][\u{1F1E6}-\u{1F1FF}]|\p{Extended_Pictographic}(?:[\uFE0E\uFE0F\p{Emoji_Modifier}\u{E0020}-\u{E007F}]|\u200D\p{Extended_Pictographic})*)+$/u;
	// A Twemoji / WordPress core emoji asset: `<codepoints>.svg|png` under an
	// `svg/` or `72x72/` segment, from core's `/images/core/emoji/<ver>/` or a
	// Twemoji `v/<ver>/` or `assets/` prefix (the MaxCDN and jsDelivr layouts).
	// Matched against the src's path, so the mirror host does not matter and
	// query strings are ignored.
	const EMOJI_ASSET_PATH =
		/\/(?:images\/core\/emoji\/[\d.]+\/)?(?:v\/[^/]+\/)?(?:assets\/)?(?:svg|72x72)\/[0-9a-f]+(?:-[0-9a-f]+)*\.(?:svg|png)$/i;
	function isEmojiAssetSrc( src: string ): boolean {
		try {
			return EMOJI_ASSET_PATH.test( new URL( src, 'https://emoji.invalid' ).pathname );
		} catch {
			return false;
		}
	}
	return function isRuntimeEmojiReplacementImage( attrs: EmojiImageAttributes ): boolean {
		if ( ! attrs.className.split( /\s+/ ).includes( 'emoji' ) ) return false;
		// Twemoji emits exactly these; an authored image lacking either is kept.
		if ( attrs.draggable !== 'false' || attrs.role !== 'img' ) return false;
		if ( ! attrs.alt || ! EMOJI_ONLY_TEXT.test( attrs.alt ) ) return false;
		return !! attrs.src && isEmojiAssetSrc( attrs.src );
	};
}

/**
 * Whether one `<img>` is unambiguously a runtime emoji replacement image (see
 * the module comment for the strictness). Pure and attribute-level, so it is
 * unit-testable outside the browser.
 */
export const isRuntimeEmojiReplacementImage = createRuntimeEmojiPredicate();

// ---------------------------------------------------------------------------
// Source strings for browser injection
// ---------------------------------------------------------------------------

/**
 * A self-contained factory source string. Evaluated with
 * `new Function('return (' + factorySrc + ')')()()` — in a page or in Node —
 * it builds the same `isRuntimeEmojiReplacementImage` exported above.
 */
export const RUNTIME_EMOJI_PREDICATE_SOURCE: { factorySrc: string } = {
	factorySrc: createRuntimeEmojiPredicate.toString(),
};

/**
 * Builds the DOM rewrite. The replacement predicate arrives as an argument, so
 * this factory's `toString()` stays complete on its own and the browser runs
 * the same predicate the Node export and the tests use.
 */
function createEmojiTextRestore( isReplacementImage: ( attrs: EmojiImageAttributes ) => boolean ): ( root: Document ) => number {
	return function restoreEmojiText( root: Document ): number {
		let restored = 0;
		const parents = new Set< Node >();
		for ( const img of Array.from( root.querySelectorAll( 'img.emoji' ) ) ) {
			const attrs = {
				className: img.getAttribute( 'class' ) ?? '',
				draggable: img.getAttribute( 'draggable' ),
				role: img.getAttribute( 'role' ),
				alt: img.getAttribute( 'alt' ),
				src: img.getAttribute( 'src' ),
			};
			if ( ! isReplacementImage( attrs ) || attrs.alt === null ) continue;
			// The wp-emoji observer skips exactly this shape: one Text node
			// replacing one image whose data-error is load-failed. Without the
			// marker it would parse the new text straight back into an image.
			img.setAttribute( 'data-error', 'load-failed' );
			if ( img.parentNode ) parents.add( img.parentNode );
			img.replaceWith( root.createTextNode( attrs.alt ) );
			restored++;
		}
		// The emoji script split one authored Text node around each image.
		// Merge the restored text back into its neighbours so the capture holds
		// the single run the source authored, not adjacent runs that
		// serialization would have to keep apart.
		for ( const parent of parents ) parent.normalize();
		// Native glyph support can leave no images to restore even though the
		// source ships WordPress's emoji runtime. Record that dependency too.
		const settings = ( root.defaultView as ( Window & { _wpemojiSettings?: unknown } ) | null )?._wpemojiSettings;
		if ( restored > 0 || ( settings !== null && typeof settings === 'object' ) ) {
			root.documentElement.setAttribute( 'data-blocks-engine-capture-runtime-emoji', 'wordpress' );
		}
		return restored;
	};
}

/**
 * Restores every runtime emoji replacement image under `root` to a text node
 * of its `alt`, and returns how many were restored. Reads and writes only the
 * given document, so the same code runs in a page and in a test DOM.
 */
export const restoreEmojiText = createEmojiTextRestore( isRuntimeEmojiReplacementImage );

/**
 * A self-contained factory source string. Evaluated with
 * `new Function('return (' + factorySrc + ')')()( predicate )` it builds the
 * same `restoreEmojiText` exported above; `predicate` is the function built
 * from `RUNTIME_EMOJI_PREDICATE_SOURCE.factorySrc`.
 */
export const RUNTIME_EMOJI_RESTORE_SOURCE: { factorySrc: string } = {
	factorySrc: createEmojiTextRestore.toString(),
};

/**
 * Restores runtime emoji replacement images to their alt text in the live page
 * (see the module comment). Best-effort, like the other in-page normalization
 * passes: a page that cannot answer keeps its DOM and capture continues, with
 * a diagnostic recording the loss.
 */
export async function restoreRuntimeEmoji( page: Page ): Promise< ProfileDiagnostic[] > {
	try {
		await page.evaluate( ( { predicateSrc, restoreSrc } ) => {
			const isReplacementImage = new Function( 'return (' + predicateSrc + ')' )()() as ( attrs: { className: string; draggable: string | null; role: string | null; alt: string | null; src: string | null } ) => boolean;
			const restore = new Function( 'return (' + restoreSrc + ')' )()( isReplacementImage ) as ( root: Document ) => number;
			return restore( document );
		}, { predicateSrc: RUNTIME_EMOJI_PREDICATE_SOURCE.factorySrc, restoreSrc: RUNTIME_EMOJI_RESTORE_SOURCE.factorySrc } );
		return [];
	} catch ( error ) {
		return [ { code: 'runtime_emoji_restore_failed', reason: `runtime emoji restoration unproven: ${ error instanceof Error ? error.message : String( error ) }` } ];
	}
}
