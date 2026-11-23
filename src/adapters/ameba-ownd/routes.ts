// Ameba Ownd's public route table, as every site's `siteConfig.routings`
// declares it. Paths are fixed by the platform, not authored.

export type AmebaRouteKind = 'homepage' | 'post' | 'term-archive' | 'date-archive' | 'listing' | 'page';

const POST = /^\/posts\/(\d+)\/?$/;
const CATEGORY = /^\/posts\/categor(?:y|ies)\/(\d+)\/?$/;
const CATEGORY_PAGE = /^\/posts\/categor(?:y|ies)\/\d+\/page\/[^/]+\/?$/;
const ARCHIVE = /^\/posts\/archives\/(\d{4})\/(\d{2})\/?$/;
const ARCHIVE_PAGE = /^\/posts\/archives\/\d{4}\/\d{2}\/page\/[^/]+\/?$/;

function pathname( url: string ): string | undefined {
	try {
		return new URL( url ).pathname;
	} catch {
		return undefined;
	}
}

export function amebaRouteKind( url: string ): AmebaRouteKind {
	const path = pathname( url ) ?? '';
	if ( path === '' || path === '/' ) return 'homepage';
	if ( POST.test( path ) ) return 'post';
	if ( CATEGORY.test( path ) ) return 'term-archive';
	if ( ARCHIVE.test( path ) ) return 'date-archive';
	if ( CATEGORY_PAGE.test( path ) || ARCHIVE_PAGE.test( path ) || path.startsWith( '/authors/' ) ) return 'listing';
	return 'page';
}

/** The numeric id of a category archive's first page, or undefined for any other route. */
export function amebaCategoryId( url: string ): string | undefined {
	const match = CATEGORY.exec( pathname( url ) ?? '' );
	return match?.[ 1 ];
}

export function amebaPostUrl( id: string, origin: string ): string {
	return new URL( `/posts/${ id }`, origin ).href;
}

export function amebaCategoryUrl( id: string, origin: string ): string {
	return new URL( `/posts/categories/${ id }`, origin ).href;
}

/** The blog's own list pagination (`/posts/page/N`); the homepage is its first page. */
export function amebaPostListUrl( page: number, origin: string ): string {
	return new URL( `/posts/page/${ page }`, origin ).href;
}
