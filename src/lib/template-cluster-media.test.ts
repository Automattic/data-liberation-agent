import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { TemplateClusterDeferral } from './template-cluster-deferral.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { deriveMemberDocument } from './template-clusters.js';
import { runWithTrustedOrigins } from './media-fetch/safe-fetch.js';

// One browser pass (~3s): intersection hydration and document reuse are browser behavior.
it( 'hydrates below-fold media in the existing memoized light render', async () => {
	let requests = 0;
	const server = createServer( ( request, response ) => {
		if ( request.url !== '/' ) { response.writeHead( 404 ).end(); return; }
		requests++;
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( `<body><div style="height:2000px"></div><img id="media" width="20" height="20"><script>
		new IntersectionObserver(entries => { if(entries.some(e=>e.isIntersecting)) document.querySelector('img').src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; }).observe(document.querySelector('img'));
		</script></body>` );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	const deferral = new TemplateClusterDeferral( { sourceUrl: origin, outputDir: '.', governors: new SourceRequestGovernors(), rewriteDerivedMedia: input => input.derivedHtml }, () => [] );
	try {
		await runWithTrustedOrigins( [ origin ], async () => {
			const first = await deferral.document( `${ origin }/`, 'rendered' );
			expect( first ).toHaveProperty( 'html' );
			if ( ! ( 'html' in first ) ) return;
			expect( first.html ).toContain( 'src="data:image/gif;' );
			const requestsAfterRender = requests; // Source identity may also request the entrypoint.
			expect( await deferral.document( `${ origin }/`, 'rendered' ) ).toBe( first );
			expect( requests ).toBe( requestsAfterRender );
		} );
	} finally {
		await deferral.close();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
	}
}, 30_000 );

it( 'declines runtime media when the light-render budget is exhausted', async () => {
	const deferral = new TemplateClusterDeferral( { sourceUrl: 'https://fixture.example', outputDir: '.', governors: new SourceRequestGovernors(), deadline: 0 }, () => [] );
	const rendered = await deferral.document( 'https://fixture.example/member', 'rendered' );
	expect( rendered ).toEqual( { unavailable: 'light render budget exhausted' } );
	const html = '<body><main>Article</main></body>';
	expect( deriveMemberDocument( {
		repServerHtml: html, memberServerHtml: html, repProcessedHtml: html, baseUrl: 'https://fixture.example',
		memberRenderedHtml: 'html' in rendered ? rendered.html : undefined,
		rewriteDerivedMedia: input => input.memberRenderedHtml ? input.derivedHtml : undefined,
	} ) ).toMatchObject( { ok: false, gate: { code: 'runtime_media_unmapped' } } );
	await deferral.close();
} );
