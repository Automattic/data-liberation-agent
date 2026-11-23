import type { TemplateIdentity } from '../../lib/template-groups.js';
import { amebaNextState } from './next-data.js';

const SHARED_TEMPLATES = new Set( [ 'blog_post_detail', 'blog_post_category', 'blog_post_archive' ] );

/**
 * The platform route a document was rendered as. Posts, category archives and
 * month archives share one template each; the homepage, blog list pages and
 * static pages are authored per route.
 */
export const amebaTemplateIdentity: TemplateIdentity = ( html, url ) => {
	const routeType = amebaNextState( html )?.routeType;
	if ( ! routeType ) return undefined;
	return SHARED_TEMPLATES.has( routeType ) ? `ameba-ownd:${ routeType }` : `ameba-ownd:${ routeType }:${ new URL( url ).pathname }`;
};
