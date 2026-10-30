import type { Page } from 'playwright';
import type { CleanupRule } from '../../lib/source-cleanup.js';
import type { ProbeExclusion } from '../../lib/screenshot/probe-exclusions.js';

// Medium's platform chrome, as rendered on author profiles and stories
// (2026-10). Class names are build hashes; the rules key on Medium's
// `data-testid`s, ARIA labels, its few semantic `pw-` classes and link
// targets. Owner content (name, avatar, profile tabs, story list, story body,
// dates, tags) carries none of these markers, so it stays.

// Containers that hold owner content: a chrome rule widening to an ancestor
// stops below these.
const OWNER = 'main, article, [data-testid="authorName"], [data-testid="storyTitle"]';
// Medium's clap control. The header bar carries the testid, the phone bar only
// the `pw-multi-vote-icon` class.
const CLAP = '[data-testid$="ClapButton"], .pw-multi-vote-icon';

const ACCOUNT_CONTROLS = [
	'a[href^="/m/signin"]',
	'a[href^="https://medium.com/m/signin"]',
	'[data-testid="headerSignUpButton"]',
	'[data-testid="headerSignInButton"]',
	'[data-testid="audioPlayButton"]',
	'button[aria-label^="Follow "]',
	'button[aria-label="responses"]',
	'[aria-haspopup="dialog"]:has([data-testid$="SocialShareButton"])',
	'[aria-describedby^="creatorInfoPopover"]',
].join(', ');

export const cleanupRules: CleanupRule[] = [
	// The global header: the "Open in app" bar, Medium logo, search pill,
	// "Get app", "Write", "Sign up"/"Sign in" and the user avatar menu share one
	// wrapper above the page. The outermost wrapper of the logo that holds no
	// owner content is that header.
	{
		id: 'medium-global-nav',
		category: 'source-attribution',
		selector: `div:has([data-testid="headerMediumLogo"]):not(:has(${ OWNER })), a[href="/sitemap/sitemap.xml"]`,
	},
	// Medium's sign-up/sign-in modal ("Join Medium.") and its empty shell.
	{ id: 'medium-signin-modal', category: 'provider-service', selector: '[role="dialog"]:has(.pw-susi-modal), .pw-susi-modal' },
	// A story's clap / responses / repost / bookmark / listen / share bar, in
	// the header, footer and phone dock: the outermost wrapper of the clap
	// control that holds no owner content.
	{
		id: 'medium-story-actions',
		category: 'provider-service',
		selector: `:is(div, footer):has(${ CLAP }):not(:has(${ OWNER }))`,
	},
	// Every remaining account-gated control. Medium routes each through
	// /m/signin (bookmark, clap, repost, listen, write, sign in); the rest are
	// marked by testid or label: sign up, follow-tag, the share menu, the
	// responses drawer, and the "details" hover card on followed writers.
	{ id: 'medium-account-controls', category: 'provider-service', selector: ACCOUNT_CONTROLS },
	// The "Get <writer>'s stories in your inbox" email form Medium inserts into
	// story bodies posts to Medium's account system and carries its reCAPTCHA.
	{ id: 'medium-email-subscribe', category: 'provider-service', selector: 'div:has(> div > #g-recaptcha)' },
	// The responses section ("To respond to this story, get the free Medium
	// app") and app-store links.
	{
		id: 'medium-app-promotion',
		category: 'source-attribution',
		selector: [
			`div:has(> * a[href^="medium://"]):not(:has(${ OWNER }))`,
			'a[href*="id=com.medium.reader"]',
			'a[href^="https://itunes.apple.com/app/medium"]',
			'button[aria-label="Get the Medium app"]',
		].join(', '),
	},
	// The platform footer (Help, Status, About, Careers, Press, Blog, Store,
	// Privacy, Rules, Terms, Text to speech).
	{ id: 'medium-footer', category: 'source-attribution', selector: 'div:has(> div > a[href^="https://help.medium.com/"])' },
	// "More from" / "Recommended from Medium" placeholders below a story: the
	// story column's children that are only nested empty boxes, with no text
	// or media to carry. Medium fills them from its own recommendations.
	{
		id: 'medium-recommendation-skeletons',
		category: 'provider-service',
		selector: 'div:has(> div > article) > div:has(div div div):not(:has(a, img, picture, video, iframe, svg, p, span, h1, h2, h3, h4, h5, h6, button, input, ul, ol, table, figure))',
	},
];

/**
 * Hover cards Medium's runtime serves (tag and writer cards, each offering
 * "Follow"), the profile tab-strip arrows, and any account-gated control
 * re-rendered after cleanup. A copy cannot carry their runtime states; probing
 * them cost 20-80 s per route.
 */
export const probeExclusions: readonly ProbeExclusion[] = [
	{
		id: 'medium-hover-cards',
		selector: '[aria-haspopup="dialog"]:has(a[href^="/tag/"]), [aria-describedby^="creatorInfoPopover"]',
		reason: 'Medium tag and writer hover cards are platform runtime',
	},
	// The profile tab strip's scroll arrows: Medium's runtime scrolls the strip,
	// which also scrolls natively. Beside the story list they read as collection
	// paging and cost a 30 s collection probe per profile document.
	{
		id: 'medium-tab-scroll',
		selector: 'button[aria-label="next sections"], button[aria-label="previous sections"]',
		reason: 'Medium tab-strip scroll arrows are platform runtime',
	},
	{
		id: 'medium-account-controls',
		selector: `${ ACCOUNT_CONTROLS }, ${ CLAP }, [data-testid="headerUserIcon"], [data-testid="headerSearchInput"]`,
		reason: 'Medium account-gated controls only work signed in to Medium',
	},
];

/**
 * Remove Medium's "Follow" / "Follow writer" buttons. Logged out they open the
 * sign-up modal; they carry no testid or label, only their text. Each sits
 * alone in a wrapper, which goes with it when left empty.
 */
export async function removeFollowButtons( page: Page ): Promise<number> {
	return page.evaluate( () => {
		let removed = 0;
		for ( const button of Array.from( document.querySelectorAll( 'button' ) ) ) {
			if ( ! /^Follow(?: writer)?$/.test( ( button.textContent ?? '' ).trim() ) || button.querySelector( 'img' ) ) continue;
			let node: Element = button;
			while ( node.parentElement && node.parentElement !== document.body && node.parentElement.children.length === 1 &&
				! ( node.parentElement.textContent ?? '' ).trim().replace( /^Follow(?: writer)?$/, '' ) ) node = node.parentElement;
			node.remove();
			removed++;
		}
		return removed;
	} );
}
