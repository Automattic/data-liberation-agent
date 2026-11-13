import * as cheerio from 'cheerio';
import { readDocument, releaseDocument } from './parsed-documents.js';

/**
 * Site builders serve their own logo as the favicon when the owner never set
 * one. That icon is the platform's branding, not the site's, so a liberated
 * site must not carry it into WordPress (as `site_icon`, theme head markup, or
 * a Media Library attachment). Owner-uploaded icons live on per-site media
 * paths and are kept.
 *
 * Each entry is an exact host + path observed on live sites. Add a platform
 * only with a confirmed default URL; a guessed pattern could drop an owner's
 * own icon.
 */
interface PlatformDefaultIcon {
	platform: string;
	hosts: readonly string[];
	path: string;
}

export const PLATFORM_DEFAULT_ICONS: readonly PlatformDefaultIcon[] = [
	// Free `*.wixsite.com` sites without a custom favicon.
	{ platform: 'wix', hosts: [ 'www.wix.com', 'wix.com' ], path: '/favicon.ico' },
	// Premium / custom-domain Wix sites without a custom favicon.
	// Owner uploads are served from static.wixstatic.com/media/<owner>_<id>... instead.
	{ platform: 'wix', hosts: [ 'static.parastorage.com' ], path: '/client/pfavico.ico' },
	// Squarespace sites without a custom favicon. Owner uploads are served from
	// images.squarespace-cdn.com/content/v1/<site>/... instead.
	{ platform: 'squarespace', hosts: [ 'assets.squarespace.com' ], path: '/universal/default-favicon.ico' },
];

/** The builder whose default icon `href` names, resolved against `base`; undefined for any other icon. */
export function platformDefaultIcon( href: string, base?: string ): string | undefined {
	let url: URL;
	try {
		url = new URL( href.trim(), base );
	} catch {
		return undefined;
	}
	if ( ! /^https?:$/.test( url.protocol ) ) return undefined;
	const host = url.hostname.toLowerCase();
	const path = url.pathname.toLowerCase();
	return PLATFORM_DEFAULT_ICONS.find( icon => icon.hosts.includes( host ) && icon.path === path )?.platform;
}

const ICON_RELATION = /(?:^|-)icon$/;

/** True for an icon `<link>` (icon, shortcut icon, apple-touch-icon, mask-icon...) that points at a builder default icon. */
export function isPlatformDefaultIconLink( rel: string | undefined, href: string | undefined, base?: string ): boolean {
	if ( ! href ) return false;
	const relations = ( rel ?? '' ).toLowerCase().split( /\s+/ );
	return relations.some( value => ICON_RELATION.test( value ) ) && platformDefaultIcon( href, base ) !== undefined;
}

/**
 * Remove builder default icon links from a captured document before it is
 * made portable, so no later stage localizes, exports or imports them.
 * Documents that name no default icon host are returned untouched.
 */
export function withoutPlatformDefaultIcons( html: string, documentUrl: string ): string {
	const lower = html.toLowerCase();
	if ( ! PLATFORM_DEFAULT_ICONS.some( icon => icon.hosts.some( host => lower.includes( host ) ) ) ) return html;
	const $ = readDocument( html );
	let base = documentUrl;
	try { base = new URL( $( 'base[href]' ).first().attr( 'href' ) ?? documentUrl, documentUrl ).href; }
	catch { /* Malformed base: retain the document URL. */ }
	const isDefaultIcon = ( markup: string ) => {
		const fragment = cheerio.load( markup, null, false );
		return fragment( 'link[href]' ).toArray().some( element => isPlatformDefaultIconLink( fragment( element ).attr( 'rel' ), fragment( element ).attr( 'href' ), base ) );
	};
	const links = $( 'link[href]' ).filter( ( _index, element ) => isPlatformDefaultIconLink( $( element ).attr( 'rel' ), $( element ).attr( 'href' ), base ) );
	// Wix ships a commented-out `<!-- <link rel="mask-icon" href=".../favicon.ico"> -->`.
	// It is inert, but resource localization still rewrites and copies its URL.
	const comments = $.root().find( '*' ).addBack().contents().filter( ( _index, node ) =>
		node.type === 'comment' && /<link\b/i.test( node.data ) && isDefaultIcon( node.data ) );
	if ( ! links.length && ! comments.length ) return html;
	releaseDocument( html, $ );
	links.remove();
	comments.remove();
	return $.html();
}
