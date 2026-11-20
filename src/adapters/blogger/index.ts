import type { PlatformAdapter } from '../../types.js';
import { bloggerAcquisition } from './acquisition.js';
import { detection } from './detection.js';
import { discover } from './discover.js';
import { bloggerImageOriginal } from './media.js';
import { bloggerStructuredContent } from './template-content.js';
import { providerCreditRules } from '../../lib/source-cleanup.js';

export type { BloggerFeedAccounting, BloggerInventory } from './types.js';

export const bloggerAdapter: PlatformAdapter = {
	id: 'blogger',
	detection,
	discover,
	routeScope: sourceUrl => ( {
		origin: new URL( sourceUrl ).origin,
		pathPrefixes: [ '/' ],
		ignoredQueryParams: [ 'updated-max', 'updated-min', 'max-results', 'start', 'by-date', 'reverse-paginate' ],
	} ),
	acquisition: bloggerAcquisition,
	structuredContent: bloggerStructuredContent,
	resolveImageOriginal: bloggerImageOriginal,
	liberation: {
		cleanupRules: [
			// These hosted services require Blogger's runtime; surrounding comments stay.
			{
				id: 'blogger-runtime-frames', category: 'provider-service', selector: 'iframe[src]',
				hosts: ['blogger.com'], pathPrefixes: ['/comment/frame/', '/followers/frame/'],
			},
			{ id: 'blogger-comment-editor', category: 'provider-service', selector: 'a#comment-editor-src' },
			// Blogger's own widget types, named by the platform in every theme.
			// Each needs a Blogger account, feed or runtime a copy cannot serve.
			{ id: 'blogger-followers', category: 'provider-service', selector: '.widget.Followers', evidence: 'Blogger serves followers from its account runtime.' },
			{ id: 'blogger-follow-by-email', category: 'provider-service', selector: '.widget.FollowByEmail', evidence: 'Blogger email subscriptions ran on the retired FeedBurner service.' },
			{ id: 'blogger-subscribe', category: 'provider-service', selector: '.widget.Subscribe', evidence: 'Blogger subscribe links point at Blogger feeds.' },
			{ id: 'blogger-report-abuse', category: 'provider-service', selector: '.widget.ReportAbuse', evidence: 'Blogger abuse reports file against the Blogger account.' },
			{ id: 'blogger-navbar', category: 'provider-service', selector: '.widget.Navbar', evidence: 'The Blogger navbar is a Blogger account toolbar.' },
			{ id: 'blogger-attribution', category: 'source-attribution', selector: '.widget.Attribution' },
			{ id: 'blogger-adsense', category: 'advertisement', selector: '.widget.AdSense' },
			...providerCreditRules('blogger', ['blogger.com'], 'Blogger'),
		],
	},
};
