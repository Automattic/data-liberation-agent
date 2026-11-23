// Ameba Ownd renders every public page with Next.js and ships its Redux state
// in `__NEXT_DATA__`: the route the page was resolved as (`blog`,
// `blog_post_detail`, `blog_post_category`, `blog_post_archive`, `static`)
// and the post, list, category or page data it rendered.

/** One block of a post or page body, as the platform stores it. */
export interface AmebaBlock {
	type: string;
	format?: string;
	value?: string;
	url?: string;
	link?: string;
	target?: string;
	json?: { title?: string; description?: string; url?: string; thumbnail?: string };
}

export interface AmebaCategory {
	id: string;
	label: string;
	publishedCount?: number;
}

export interface AmebaPost {
	id: string;
	status?: string;
	title?: string;
	contents?: AmebaBlock[];
	ogpImageUrl?: string;
	blogCategories?: AmebaCategory[];
	user?: { nickname?: string };
	publishedAt?: string;
	updatedAt?: string;
}

export interface AmebaPage {
	id: string;
	type?: string;
	title?: string;
	urlPath?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface AmebaPostList {
	posts: AmebaPost[];
	total: number | null;
	limit: number | null;
}

export interface AmebaNextState {
	/** The platform route type, e.g. `blog_post_detail`. */
	routeType?: string;
	params: Record< string, string >;
	postDetail?: AmebaPost;
	postList?: AmebaPostList;
	category?: AmebaCategory;
	page?: AmebaPage;
}

const NEXT_DATA = /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

type Json = Record< string, unknown >;

function record( value: unknown ): Json | undefined {
	return value !== null && typeof value === 'object' && ! Array.isArray( value ) ? value as Json : undefined;
}

function string( value: unknown ): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** The first loaded `data` of a keyed Redux slice (`postDetail-blogPostId:…`). */
function loadedData( slice: unknown ): { data: unknown; meta?: Json } | undefined {
	for ( const value of Object.values( record( slice ) ?? {} ) ) {
		const entry = record( value );
		if ( entry && entry.data !== undefined && entry.data !== null ) return { data: entry.data, meta: record( entry.meta ) };
	}
	return undefined;
}

function post( value: unknown ): AmebaPost | undefined {
	const data = record( value );
	const id = string( data?.id );
	if ( ! data || ! id ) return undefined;
	return {
		id,
		status: string( data.status ),
		title: string( data.title ),
		contents: Array.isArray( data.contents ) ? data.contents.filter( block => record( block ) && typeof ( block as Json ).type === 'string' ) as AmebaBlock[] : [],
		ogpImageUrl: string( data.ogpImageUrl ),
		blogCategories: Array.isArray( data.blogCategories )
			? data.blogCategories.flatMap( category => {
				const item = record( category );
				const categoryId = string( item?.id );
				const label = string( item?.label );
				const count = item?.publishedCount;
				return categoryId && label?.trim() ? [ { id: categoryId, label: label.trim(), ...( typeof count === 'number' ? { publishedCount: count } : {} ) } ] : [];
			} )
			: [],
		user: { nickname: string( record( data.user )?.nickname ) },
		publishedAt: string( data.publishedAt ),
		updatedAt: string( data.updatedAt ),
	};
}

/** Parse the platform state from a server document. Undefined for any other document. */
export function amebaNextState( html: string ): AmebaNextState | undefined {
	const match = NEXT_DATA.exec( html );
	if ( ! match ) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse( match[ 1 ]! );
	} catch {
		return undefined;
	}
	const state = record( record( record( record( parsed )?.props )?.pageProps )?.state );
	if ( ! state || ! record( state.siteConfig ) ) return undefined;
	const route = record( state.route );
	const routeType = string( record( record( route?.route )?.route )?.type );
	const params: Record< string, string > = {};
	for ( const [ key, value ] of Object.entries( record( route?.params ) ?? {} ) ) if ( typeof value === 'string' ) params[ key ] = value;
	const result: AmebaNextState = { routeType, params };
	const detail = loadedData( state.postDetail );
	if ( detail ) result.postDetail = post( detail.data );
	const list = loadedData( state.postList );
	if ( list && Array.isArray( list.data ) ) {
		const pagination = record( list.meta?.pagination );
		const number = ( value: unknown ) => typeof value === 'number' && Number.isSafeInteger( value ) && value >= 0 ? value : null;
		result.postList = {
			posts: list.data.flatMap( item => post( item ) ?? [] ),
			total: number( pagination?.total ),
			limit: number( pagination?.limit ),
		};
	}
	const category = record( loadedData( state.category )?.data );
	if ( category && string( category.id ) && string( category.label ) ) result.category = { id: category.id as string, label: ( category.label as string ).trim() };
	const page = record( loadedData( state.page )?.data );
	if ( page && string( page.id ) ) {
		result.page = { id: page.id as string, type: string( page.type ), title: string( page.title ), urlPath: string( page.urlPath ), createdAt: string( page.createdAt ), updatedAt: string( page.updatedAt ) };
	}
	return result;
}
