import * as cheerio from 'cheerio';
import type { StructuredContentEntry, StructuredContentEnumeration, StructuredContentSource } from '../../platform/types.js';
import type { SourceRequestGovernors } from '../../lib/source-request-governor.js';
import { safeFetch } from '../../lib/media-fetch/safe-fetch.js';
import { SOURCE_USER_AGENT } from '../../lib/browser-kit/source-identity.js';
import { amebaNextState, type AmebaBlock, type AmebaCategory, type AmebaPost } from './next-data.js';
import { amebaCategoryId, amebaCategoryUrl, amebaPostListUrl, amebaPostUrl } from './routes.js';

/** The post body slot of the article template. */
const BODY = '.blog-article__body';
/** Ameba Ownd shows and schedules posts in Japan time; it has no per-site zone setting. */
const SITE_OFFSET_MINUTES = 9 * 60;
const SITE_OFFSET = '+09:00';
/** A list page holds 12 posts; 500 pages bounds enumeration at 6,000 posts. */
export const AMEBA_LIST_PAGE_CAP = 500;
const STATIC_PAGE_CAP = 200;

/** Per-entry platform fields the article template renders outside its body. */
interface PostDetails {
	publishedAt: string;
	categories: AmebaCategory[];
	textOnly: boolean;
}
const details = new WeakMap< StructuredContentEntry, PostDetails >();
/** Category label → id, per site origin, learned from enumerated posts. */
const categoryIds = new Map< string, Map< string, string > >();

/**
 * A platform UTC timestamp as the site's own local time, e.g.
 * `2019-05-08T18:42:03Z` → `2019-05-09T03:42:03+09:00`. Ameba's zero time
 * (`0001-01-01T00:00:00Z`) and unparseable values are absent.
 */
export function amebaLocalTimestamp( value: string | undefined ): string {
	if ( ! value ) return '';
	const time = Date.parse( value );
	if ( Number.isNaN( time ) || new Date( time ).getUTCFullYear() < 1970 ) return '';
	return new Date( time + SITE_OFFSET_MINUTES * 60_000 ).toISOString().replace( /\.\d{3}Z$/, SITE_OFFSET );
}

/** The article's visible date, `2019.05.09 03:42`, in site time. */
export function amebaDisplayDate( value: string ): string {
	const local = amebaLocalTimestamp( value );
	return local ? `${ local.slice( 0, 10 ).replace( /-/g, '.' ) } ${ local.slice( 11, 16 ) }` : '';
}

const escapeAttribute = ( value: string ) => value.replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' ).replace( /</g, '&lt;' );
const escapeText = ( value: string ) => value.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );

/**
 * A post's blocks as body HTML. Text blocks use the article template's own
 * markup; image and link-card blocks keep their image, link and text.
 * Other block types (video, embeds) have no static form here and are left out.
 */
export function amebaBlocksHtml( blocks: readonly AmebaBlock[] ): string {
	return blocks.map( block => {
		if ( block.type === 'text' && typeof block.value === 'string' ) {
			return `<div class="blog-body__item"><div class="blog-body__text u-txt-clr u-clr-area" data-block-type="text">${ block.value }</div></div>`;
		}
		if ( block.type === 'image' && block.url ) {
			const image = `<img src="${ escapeAttribute( block.url ) }" alt="">`;
			return `<div class="blog-body__item"><div class="img" data-block-type="image">${ block.link ? `<a href="${ escapeAttribute( block.link ) }">${ image }</a>` : image }</div></div>`;
		}
		if ( block.type === 'quote' && block.url ) {
			const card = block.json ?? {};
			return `<div class="blog-body__item"><div data-block-type="quote"><a href="${ escapeAttribute( block.url ) }">${ escapeText( card.title ?? block.url ) }</a>${ card.description ? `<p>${ escapeText( card.description ) }</p>` : '' }</div></div>`;
		}
		return '';
	} ).join( '' );
}

/** One published post as a structured entry; Ameba allows untitled posts. Undefined for drafts or undated posts. */
export function amebaPostEntry( post: AmebaPost, origin: string ): StructuredContentEntry | undefined {
	if ( post.status !== undefined && post.status !== 'publish' ) return undefined;
	const published = amebaLocalTimestamp( post.publishedAt );
	if ( ! /^\d+$/.test( post.id ) || ! published ) return undefined;
	const blocks = post.contents ?? [];
	const firstImage = blocks.find( block => block.type === 'image' && block.url )?.url;
	const categories = post.blogCategories ?? [];
	const entry: StructuredContentEntry = {
		permalink: amebaPostUrl( post.id, origin ),
		slug: post.id,
		kind: 'post',
		title: post.title?.trim() ?? '',
		contentHtml: amebaBlocksHtml( blocks ),
		published,
		updated: amebaLocalTimestamp( post.updatedAt ) || published,
		author: post.user?.nickname?.trim() ?? '',
		terms: [ ...new Set( categories.map( category => category.label ) ) ],
		...( post.ogpImageUrl || firstImage ? { image: post.ogpImageUrl || firstImage } : {} ),
	};
	details.set( entry, { publishedAt: post.publishedAt!, categories, textOnly: blocks.length > 0 && blocks.every( block => block.type === 'text' ) } );
	return entry;
}

function rememberCategories( origin: string, categories: readonly AmebaCategory[] ): void {
	let byLabel = categoryIds.get( origin );
	if ( ! byLabel ) categoryIds.set( origin, byLabel = new Map() );
	for ( const category of categories ) if ( ! byLabel.has( category.label ) ) byLabel.set( category.label, category.id );
}

/**
 * Categories are the only Ameba taxonomy; each archive lives at `/posts/categories/<id>`.
 * Ids are learned during enumeration, which always runs before terms are projected.
 */
export function amebaTermArchiveUrl( term: string, sourceUrl: string ): string {
	const origin = new URL( sourceUrl ).origin;
	const id = categoryIds.get( origin )?.get( term );
	return id ? amebaCategoryUrl( id, origin ) : new URL( `/posts/categories/${ encodeURIComponent( term ) }`, origin ).href;
}

/** The category a category archive's first page names; pagination and other routes are not term archives. */
export function amebaTermName( url: string ): string | undefined {
	const id = amebaCategoryId( url );
	if ( ! id ) return undefined;
	const origin = new URL( url ).origin;
	for ( const [ label, known ] of categoryIds.get( origin ) ?? [] ) if ( known === id ) return label;
	return undefined;
}

async function fetchDocument( url: string, governors: SourceRequestGovernors ): Promise< string | undefined > {
	const response = await safeFetch( url, { governors, timeoutMs: 15_000, maxBytes: 16 * 1024 * 1024, headers: { 'User-Agent': SOURCE_USER_AGENT } } );
	return response.status >= 200 && response.status < 300 ? response.body.toString( 'utf8' ) : undefined;
}

function inventoryUrls( inventory: unknown ): string[] {
	const urls = ( inventory as { urls?: Array< { url?: unknown } > } | undefined )?.urls ?? [];
	return urls.flatMap( entry => typeof entry?.url === 'string' ? [ entry.url ] : [] );
}

/**
 * Enumerate posts from the blog's list pages (`/posts/page/N`), whose
 * `__NEXT_DATA__` carries each post's full blocks, categories and dates —
 * one request per 12 posts. Static pages come from the discovered inventory.
 */
export async function enumerateAmebaContent( sourceUrl: string, { governors, inventory }: { governors: SourceRequestGovernors; inventory?: unknown } ): Promise< StructuredContentEnumeration > {
	const origin = new URL( sourceUrl ).origin;
	// Each enumeration learns the site's current categories afresh.
	categoryIds.delete( origin );
	const result: StructuredContentEnumeration = { entries: [], diagnostics: [] };
	const diagnostic = ( code: string, url: string, reason: string ) => result.diagnostics.push( { code, url, reason } );
	const seen = new Set< string >();
	let total: number | null = null;
	let pages: number | null = null;
	for ( let page = 1; page <= ( pages ?? 1 ); page++ ) {
		if ( page > AMEBA_LIST_PAGE_CAP ) {
			diagnostic( 'ameba_post_list_bounded', amebaPostListUrl( page, origin ), `Stopped after ${ AMEBA_LIST_PAGE_CAP } list pages` );
			break;
		}
		const url = amebaPostListUrl( page, origin );
		let html: string | undefined;
		try {
			html = await fetchDocument( url, governors );
		} catch ( error ) {
			diagnostic( 'ameba_post_list_failed', url, error instanceof Error ? error.message : String( error ) );
			break;
		}
		const list = html ? amebaNextState( html )?.postList : undefined;
		if ( ! list ) {
			diagnostic( 'ameba_post_list_failed', url, html ? 'List page carries no post list data' : 'List page unavailable' );
			break;
		}
		if ( pages === null ) {
			total = list.total;
			const limit = list.limit || list.posts.length;
			// Without a declared total, read on until a list page comes back empty.
			pages = total !== null && limit ? Math.ceil( total / limit ) : AMEBA_LIST_PAGE_CAP + 1;
		}
		if ( list.posts.length === 0 ) break;
		for ( const post of list.posts ) {
			const entry = amebaPostEntry( post, origin );
			if ( ! entry ) {
				diagnostic( 'ameba_post_rejected', amebaPostUrl( post.id, origin ), 'Unpublished or undated post' );
				continue;
			}
			if ( seen.has( entry.permalink ) ) continue;
			seen.add( entry.permalink );
			rememberCategories( origin, details.get( entry )!.categories );
			result.entries.push( entry );
		}
	}
	if ( total !== null && seen.size < total ) {
		diagnostic( 'ameba_post_list_incomplete', origin, `${ seen.size } of ${ total } declared posts enumerated` );
	}
	const pageUrls = inventoryUrls( inventory ).filter( url => {
		try {
			return new URL( url ).origin === origin && /^\/pages\/\d+(?:\/|$)/.test( new URL( url ).pathname );
		} catch {
			return false;
		}
	} );
	for ( const url of pageUrls.slice( 0, STATIC_PAGE_CAP ) ) {
		try {
			const html = await fetchDocument( url, governors );
			const page = html ? amebaNextState( html )?.page : undefined;
			if ( ! page || page.type !== 'static' || ! page.title?.trim() ) {
				diagnostic( 'ameba_page_rejected', url, 'Document carries no static page data' );
				continue;
			}
			const created = amebaLocalTimestamp( page.createdAt );
			let slug = new URL( url ).pathname.split( '/' ).filter( Boolean ).at( -1 ) ?? page.id;
			try { slug = decodeURIComponent( slug ); } catch { /* Keep the source escape. */ }
			result.entries.push( {
				permalink: url, slug, kind: 'page', title: page.title.trim(), contentHtml: '',
				published: created, updated: amebaLocalTimestamp( page.updatedAt ) || created, author: '', terms: [],
			} );
		} catch ( error ) {
			diagnostic( 'ameba_page_rejected', url, error instanceof Error ? error.message : String( error ) );
		}
	}
	return result;
}

function signature( html: string, base: string ): string {
	const doc = cheerio.load( html );
	doc( 'script, style' ).remove();
	const urls = ( selector: string, attribute: string ) => doc( selector ).toArray().map( node => {
		const value = doc( node ).attr( attribute ) ?? '';
		try { return new URL( value, base ).href; } catch { return value; }
	} ).sort();
	return JSON.stringify( [ doc.root().text().replace( /\s+/g, ' ' ).trim(), urls( 'a[href]', 'href' ), urls( 'img[src]', 'src' ) ] );
}

/** True only when the document's single article body matches the entry's blocks. */
export function amebaBodyEquivalent( html: string, entry: StructuredContentEntry ): boolean {
	const $ = cheerio.load( html );
	const bodies = $( BODY );
	if ( bodies.length !== 1 || ! entry.contentHtml.trim() ) return false;
	return signature( bodies.html() ?? '', entry.permalink ) === signature( entry.contentHtml, entry.permalink );
}

/**
 * The representative's article document carrying the member's title, date,
 * categories and body. Only text-only members derive: other block types are
 * rendered by the platform with markup the entry cannot reproduce exactly.
 */
export function amebaMemberDocument( html: string, representative: StructuredContentEntry, member: StructuredContentEntry ): string | undefined {
	const repDetails = details.get( representative );
	const memberDetails = details.get( member );
	// Untitled posts render no title heading, so they never share a representative's layout.
	if ( member.kind !== 'post' || ! repDetails || ! memberDetails?.textOnly || ! representative.title || ! member.title || ! amebaBodyEquivalent( html, representative ) ) return undefined;
	const $ = cheerio.load( html );
	const titles = $( 'h1.blog-title__text' );
	const dates = $( 'time.blog-article__date' );
	const categoryLists = $( '.bloginfo-category-list' );
	if ( titles.length !== 1 || dates.length !== 1 || categoryLists.length > 1 ) return undefined;
	// An uncategorized representative has no list to carry a member's categories.
	if ( categoryLists.length === 0 && memberDetails.categories.length > 0 ) return undefined;
	titles.text( member.title );
	dates.attr( 'datetime', memberDetails.publishedAt ).text( amebaDisplayDate( memberDetails.publishedAt ) );
	const origin = new URL( member.permalink ).origin;
	categoryLists.html( memberDetails.categories.map( category => {
		const count = category.publishedCount === undefined ? '' : `<!-- -->(<!-- -->${ category.publishedCount }<!-- -->)`;
		return `<li class="bloginfo-category-list__item"><a class="u-txt-clr u-txt-clr--lv2" href="${ new URL( amebaCategoryUrl( category.id, origin ) ).pathname }">${ escapeText( category.label ) }${ count }</a></li>`;
	} ).join( '' ) );
	// Head text that names the post carries the member's title; descriptions and
	// share images summarize the representative's body and are not reproduced.
	$( 'title' ).first().text( $( 'title' ).first().text().split( representative.title ).join( member.title ) );
	$( 'meta[name="description"], meta[property="og:description"], meta[name="twitter:description"], meta[property="og:image"], meta[name="twitter:image"]' ).remove();
	$( 'meta[content]' ).each( ( _, node ) => {
		const element = $( node );
		element.attr( 'content', element.attr( 'content' )!.split( representative.title ).join( member.title ) );
	} );
	// Post permalinks are `/posts/<digits>`; a longer id must not match.
	const repPath = new RegExp( `${ new URL( representative.permalink ).pathname }(?!\\d)`, 'g' );
	const memberPath = new URL( member.permalink ).pathname;
	$( 'a[href], link[href], meta[content]' ).each( ( _, node ) => {
		const element = $( node );
		const attribute = node.tagName === 'meta' ? 'content' : 'href';
		const value = element.attr( attribute ) ?? '';
		element.attr( attribute, value.replace( repPath, memberPath ) );
	} );
	// The member's own body goes in last, so links it makes to the representative stay as written.
	$( BODY ).html( member.contentHtml );
	return $.html();
}

/** Ameba Ownd's posts and static pages, read from the platform's own page state. */
export const amebaStructuredContent: StructuredContentSource = {
	enumerate: enumerateAmebaContent,
	contentSlotSelector: BODY,
	bodyEquivalent: amebaBodyEquivalent,
	memberDocument: amebaMemberDocument,
	termArchiveUrl: amebaTermArchiveUrl,
	termName: amebaTermName,
};
