import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySourceCleanup, cleanupPolicy } from '../../lib/source-cleanup.js';
import { probeExclusionSkip } from '../../lib/screenshot/probe-exclusions.js';
import { applyOwnerIdentity, removeFollowButtons } from './capture.js';
import { matchClientErrorShell } from '../../lib/screenshot/document-integrity.js';
import { mediumAdapter } from './index.js';

// The shape of a Medium profile and story as rendered logged out (2026-10):
// hashed class names reduced to letters, owner text replaced, icons omitted.
const HEADER = `<a href="/sitemap/sitemap.xml" class="d">Sitemap</a>
<div class="e f">
	<div class="i j"><a href="https://play.google.com/store/apps/details?id=com.medium.reader&amp;referrer=x">Open in app</a>
		<div><p><span><button data-testid="headerSignUpButton">Sign up</button></span></p><div><p><span><a data-testid="headerSignInButton" href="/m/signin?operation=login">Sign in</a></span></p></div></div></div>
	<div class="i k">
		<div><a aria-label="Homepage" data-testid="headerMediumLogo" href="/">Logo</a><div><div><div aria-haspopup="listbox"></div><input role="combobox" aria-label="search" data-testid="headerSearchInput"></div></div></div>
		<div><button aria-label="Get the Medium app"><span>Get app</span></button></div>
		<div><span><a data-testid="headerWriteButton" href="/m/signin?operation=register"><div>Write</div></a></span></div>
		<div><div><div><button aria-label="user options menu" data-testid="headerUserIcon"><img alt="" src="data:,"></button></div></div></div>
	</div>
</div>`;

const PROFILE = `<div class="am"><main>
	<div><div><img id="owner-avatar" alt="Example Author" src="data:,"><span id="owner-name">Example Author</span></div><div><button><span><span>Follow</span></span></button></div></div>
	<nav><a role="tab" href="/@owner">Home</a> <a role="tab" href="/@owner/about">About</a></nav>
	<article data-testid="post-preview" aria-label="First story"><div>
		<p id="preview-date"><span>Jan 2, 2020</span></p>
		<a href="/@owner/first-story-abc"><h2>First story</h2></a>
		<div><span><div><div tabindex="-1"><span><a href="/m/signin?actionUrl=x%2Fbookmark"><span>Save</span></a></span></div></div></span></div>
	</div></article>
</main>
<div class="side">
	<h2>Following</h2>
	<ul><li><a href="/@other">Other Writer</a><div aria-describedby="creatorInfoPopover-1" aria-haspopup="dialog"><div><button aria-controls="creatorInfoPopover-1" aria-label="Other Writer details"></button></div></div></li></ul>
	<div class="pm"><div><a href="https://help.medium.com/hc/en-us"><p>Help</p></a></div><div><a href="https://policy.medium.com/terms"><p>Terms</p></a></div><div><a href="https://speechify.com/x"><p>Text to speech</p></a></div></div>
</div></div>`;

const STORY = `<div class="am"><div class="col">
	<div class="side"><a href="/@owner"><img alt="Example Author" src="data:,"></a><h2>Example Author</h2><p><button>Follow writer</button></p></div>
	<div class="fy"><article><section>
		<div aria-haspopup="dialog"><a id="tag" href="/tag/gardening"><span>Gardening</span></a></div><button aria-label="Follow Gardening"></button>
		<h1 data-testid="storyTitle">A story title</h1>
		<div>
			<div><a data-testid="authorName" href="/@owner">Example Author</a><button><span><span>Follow</span></span></button></div>
			<div><span id="story-date" data-testid="storyPublishDate">Mar 4, 2021</span></div>
			<div><div><span><a data-testid="headerClapButton" href="/m/signin?actionUrl=x%2Fvote"><div class="pw-multi-vote-icon"></div></a></span><p><span>--</span></p></div>
				<div><button aria-label="responses"></button></div>
				<div><span><a href="/m/signin?actionUrl=x%2Fplans"><button aria-label="Listen" data-testid="audioPlayButton"><p>Listen</p></button></a></span></div>
				<div aria-haspopup="dialog"><button aria-label="Share Post" data-testid="headerSocialShareButton"><p>Share</p></button></div></div>
		</div>
		<p id="body">The story body paragraph.</p>
		<div><div><h2>Get updates in your inbox</h2></div><div><p>Join for free.</p></div><div><input placeholder="Enter your email"><button>Subscribe</button></div><div><div id="g-recaptcha"></div></div></div>
	</section></article></div>
	<footer><div><span><a data-testid="footerClapButton" href="/m/signin?actionUrl=x%2Fvote"></a></span><p><span>--</span></p><div aria-haspopup="dialog"><button aria-label="Share Post" data-testid="footerSocialShareButton"></button></div></div></footer>
	<div class="written"><a href="/@owner"><h2>Written by Example Author</h2></a><div><div style=""><button><span><span>Follow</span></span></button></div></div></div>
	<div class="responses"><div><h2>No responses yet</h2></div><div><div><p>To respond, get the app.</p><div><a href="medium://p/abc">Continue in app</a></div></div><div><a href="https://itunes.apple.com/app/medium-x/id1"><img alt="" src="data:,"></a></div></div></div>
	<div><div class="am"><div><div><div></div><div></div></div><div><div></div><div></div></div></div></div></div>
	<div class="ck"><div><div class="sx"><div><a href="https://help.medium.com/hc/en-us"><p>Help</p></a></div><div><a href="https://status.medium.com/"><p>Status</p></a></div></div></div></div>
</div></div>
<div><div role="dialog"><div class="pw-susi-modal"><h2>Join now.</h2><button data-testid="close-button" aria-label="close"></button></div></div></div>`;

const text = async ( page: Page ) => ( await page.locator( 'body' ).innerText() ).replace( /\s+/g, ' ' ).trim();

describe.skipIf( process.env.SKIP_BROWSER_TESTS )( 'Medium capture cleanup', () => {
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch(); } );
	afterAll( async () => { await browser.close(); } );

	const clean = async ( body: string ) => {
		const page = await browser.newPage();
		await page.setContent( `<!doctype html><html><body><div class="a">${ body }</div></body></html>` );
		const report = await applySourceCleanup( page, cleanupPolicy( mediumAdapter.liberation?.cleanupRules ) );
		const follow = await removeFollowButtons( page );
		return { page, report, follow };
	};

	it( 'removes the global header, account controls and platform footer from a profile, keeping the owner', async () => {
		const { page, report, follow } = await clean( HEADER + PROFILE );
		try {
			expect( report.failures ).toEqual( [] );
			expect( follow ).toBe( 1 );
			expect( await text( page ) ).toBe( 'Example Author Home About Jan 2, 2020 First story Following Other Writer' );
			expect( await page.locator( '[data-testid^="header"], a[href*="/m/signin"], a[href*="medium.com"], button' ).count() ).toBe( 0 );
			expect( await page.locator( '#owner-avatar' ).count() ).toBe( 1 );
			expect( await page.locator( 'nav a[role="tab"]' ).count() ).toBe( 2 );
			expect( await page.locator( 'article[data-testid="post-preview"] a[href="/@owner/first-story-abc"]' ).count() ).toBe( 1 );
		} finally {
			await page.close();
		}
	} );

	it( 'removes story action bars, sign-up prompts, recommendation placeholders and the footer, keeping the story', async () => {
		const { page, report, follow } = await clean( HEADER + STORY );
		try {
			expect( report.failures ).toEqual( [] );
			expect( follow ).toBe( 3 );
			expect( await text( page ) ).toBe( 'Example Author Gardening A story title Example Author Mar 4, 2021 The story body paragraph. Written by Example Author' );
			expect( await page.locator( 'button, input, footer, [role="dialog"], #g-recaptcha, a[href^="medium:"], a[href*="medium.com"]' ).count() ).toBe( 0 );
			expect( await page.locator( '.col > div:has(div div div):not(:has(a, p, h2, img))' ).count() ).toBe( 0 );
			expect( await page.locator( '#tag' ).getAttribute( 'href' ) ).toBe( '/tag/gardening' );
			expect( await page.locator( '#story-date' ).innerText() ).toBe( 'Mar 4, 2021' );
		} finally {
			await page.close();
		}
	} );

	it( 'excludes tag hover cards from interaction probing', async () => {
		const page = await browser.newPage();
		try {
			await page.setContent( `<!doctype html><html><body>${ STORY }</body></html>` );
			const skip = probeExclusionSkip( mediumAdapter.liberation?.probeExclusions ?? [] )!;
			expect( await page.locator( '#tag' ).evaluate( ( element, selector ) => element.matches( selector ), skip ) ).toBe( true );
			expect( await page.locator( '#body' ).evaluate( ( element, selector ) => element.matches( selector ), skip ) ).toBe( false );
		} finally {
			await page.close();
		}
	} );
	it( "names the copy after its owner instead of Medium", async () => {
		const apollo = ( owner: Record< string, string > ) => `<script>window.__APOLLO_STATE__ = ${ JSON.stringify( {
			'User:a': { username: 'someone-else', name: 'Followed Writer', bio: 'Not the owner' },
			'User:b': { username: 'owner', name: 'Example Author', bio: 'Writes about gardens.', ...owner },
			'Collection:c': { slug: 'garden-notes', name: 'Garden Notes', description: 'A gardening publication.' },
		} ) };</script>`;
		const identity = async ( url: string, title: string, serverHtml = apollo( {} ) ) => {
			const page = await browser.newPage();
			try {
				await page.setContent( `<!doctype html><html><head><title>${ title }</title><meta property="og:title" content="${ title }"></head><body></body></html>` );
				await applyOwnerIdentity( page, url, serverHtml );
				return await page.evaluate( () => ( {
					title: document.title,
					ogTitle: document.querySelector( 'meta[property="og:title"]' )?.getAttribute( 'content' ),
					website: Array.from( document.querySelectorAll( 'script[type="application/ld+json"]' ), script => JSON.parse( script.textContent ?? '' ) ),
				} ) );
			} finally {
				await page.close();
			}
		};
		const site = ( name: string, slogan?: string, url = 'https://medium.com/@owner/' ) =>
			[ { '@context': 'https://schema.org', '@type': 'WebSite', name, url, ...( slogan ? { slogan } : {} ) } ];
		expect( await identity( 'https://medium.com/@owner/', 'Example Author – Medium' ) ).toEqual( { title: 'Example Author', ogTitle: 'Example Author', website: site( 'Example Author', 'Writes about gardens.' ) } );
		expect( ( await identity( 'https://medium.com/@owner', 'Example Author – Medium', apollo( { bio: '' } ) ) ).website, 'no bio, no slogan' ).toEqual( site( 'Example Author', undefined, 'https://medium.com/@owner' ) );
		expect( ( await identity( 'https://medium.com/garden-notes', 'Garden Notes – Medium' ) ).website, 'publication' ).toEqual( site( 'Garden Notes', 'A gardening publication.', 'https://medium.com/garden-notes' ) );
		expect( await identity( 'https://medium.com/@owner/about', 'About – Example Author – Medium' ), 'other pages only lose the suffix' ).toEqual( { title: 'About – Example Author', ogTitle: 'About – Example Author', website: [] } );
		expect( ( await identity( 'https://medium.com/@owner/', 'Example Author – Medium', '<html></html>' ) ).website, 'no Apollo state' ).toEqual( [] );
	} );

	it( 'recognizes Medium\'s error view as an error shell, not page content', () => {
		const ERROR_VIEW = `<section><div><div>500</div></div><div><h2>Apologies, but something went wrong on our end.</h2><p>Refresh the page, check <a href="https://status.medium.com">Medium's site status</a>, or <a href="https://medium.com/browse/top">find something interesting to read</a>.</p></div></section>`;
		const STATUS_STORY = `<article><h2>Outages</h2><p>See <a href="https://status.medium.com">the status page</a> and <a href="https://medium.com/browse/top">top stories</a> below.</p><p>More text.</p></article>`;
		const shell = ( body: string ) => matchClientErrorShell( `<!doctype html><html><head><title></title></head><body>${ body }</body></html>`, mediumAdapter.liberation?.clientErrorShellSelectors );
		expect( shell( ERROR_VIEW ) ).toBeDefined();
		expect( shell( HEADER + PROFILE ), 'profile' ).toBeUndefined();
		expect( shell( HEADER + STORY ), 'story' ).toBeUndefined();
		expect( shell( STATUS_STORY ), 'a story linking the same pages' ).toBeUndefined();
	} );
} );
