import { createHash } from 'node:crypto';
import { collectDirectoryEntries, createZipArchive } from './zip.js';
import { PublishError, type PublishOptions, type PublishResult, type PublishTarget } from './types.js';

const API_BASE = 'https://public-api.wordpress.com/wpcom/v2/sites';
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 300;

interface Session {
	session_id: string;
	state: string;
	plan_hash?: string;
	site_url?: string;
	receipt?: { success?: boolean; code?: string; [ key: string ]: unknown };
	upload?: { url: string; token: string; filename: string };
}

function endpoint( site: string, suffix = '' ): string {
	return `${ API_BASE }/${ encodeURIComponent( site ) }/static-site-import-session${ suffix }`;
}

async function request< T >( url: string, token: string, init: RequestInit = {} ): Promise< T > {
	const headers = new Headers( init.headers );
	headers.set( 'authorization', `Bearer ${ token }` );
	if ( ! ( init.body instanceof FormData ) ) headers.set( 'content-type', 'application/json' );
	const response = await fetch( url, { ...init, headers } );
	const body = await response.json().catch( () => ( {} ) ) as Record< string, unknown >;
	if ( ! response.ok ) {
		throw new PublishError( {
			code: String( body.code ?? `wpcom_http_${ response.status }` ),
			message: String( body.message ?? `WordPress.com returned HTTP ${ response.status }` ),
		} );
	}
	return body as T;
}

async function uploadArtifact( upload: NonNullable< Session['upload'] >, archive: Buffer ): Promise< void > {
	const form = new FormData();
	form.append(
		'file',
		new Blob( [ new Uint8Array( archive ) ], { type: 'application/zip' } ),
		upload.filename
	);
	const response = await fetch( upload.url, {
		method: 'POST',
		headers: { authorization: `Bearer ${ upload.token }` },
		body: form,
	} );
	if ( ! response.ok ) {
		throw new PublishError( {
			code: `wpcom_upload_http_${ response.status }`,
			message: `WordPress.com artifact upload returned HTTP ${ response.status }`,
		} );
	}
}

async function waitForState(
	site: string,
	token: string,
	sessionId: string,
	wanted: string
): Promise< Session > {
	for ( let attempt = 0; attempt < MAX_POLLS; attempt++ ) {
		const session = await request< Session >(
			endpoint( site, `/${ encodeURIComponent( sessionId ) }` ),
			token
		);
		if ( session.state === wanted ) return session;
		if ( session.state === 'failed' ) {
			throw new PublishError( {
				code: String( session.receipt?.code ?? 'wpcom_import_failed' ),
				message: `WordPress.com import failed${ session.receipt?.code ? `: ${ session.receipt.code }` : '' }`,
			} );
		}
		await new Promise( ( resolve ) => setTimeout( resolve, POLL_INTERVAL_MS ) );
	}
	throw new PublishError( {
		code: 'wpcom_timeout',
		message: `WordPress.com import did not reach ${ wanted } in time.`,
	} );
}

async function publishToWpcom( options: PublishOptions ): Promise< PublishResult > {
	if ( ! options.token ) {
		throw new PublishError( { code: 'token_required', message: 'WordPress.com requires WPCOM_TOKEN.' } );
	}
	if ( ! options.destination ) {
		throw new PublishError( {
			code: 'site_required',
			message: 'WordPress.com requires a destination site (--site).',
		} );
	}

	const entries = collectDirectoryEntries( options.directory );
	if ( entries.length === 0 ) {
		throw new PublishError( { code: 'empty_site', message: 'Cannot publish an empty directory.' } );
	}
	const archive = createZipArchive( entries );
	const digest = createHash( 'sha256' ).update( archive ).digest( 'hex' );
	options.log?.( `Creating WordPress.com import session for ${ options.destination }...` );
	const session = await request< Session >( endpoint( options.destination ), options.token, {
		method: 'POST',
		body: JSON.stringify( {
			source: {
				type: 'artifact_upload',
				sha256: digest,
				bytes: archive.length,
				files: entries.length,
				entrypoint: 'index.html',
			},
		} ),
	} );
	if ( ! session.session_id || ! session.upload ) {
		throw new PublishError( {
			code: 'upload_grant_missing',
			message: 'WordPress.com did not return an upload grant.',
		} );
	}

	options.log?.( `Uploading ${ entries.length } files (${ archive.length } archive bytes)...` );
	await uploadArtifact( session.upload, archive );
	await request< Session >(
		endpoint( options.destination, `/${ encodeURIComponent( session.session_id ) }/upload-complete` ),
		options.token,
		{ method: 'POST', body: '{}' }
	);

	options.log?.( 'Waiting for the WordPress.com import plan...' );
	const preview = await waitForState( options.destination, options.token, session.session_id, 'preview_ready' );
	if ( ! preview.plan_hash ) {
		throw new PublishError( {
			code: 'plan_hash_missing',
			message: 'WordPress.com preview did not return a plan hash.',
		} );
	}
	if ( ! options.approve ) {
		throw new PublishError( {
			code: 'approval_required',
			message: `WordPress.com plan ${ preview.plan_hash } is ready; rerun with --yes to approve it.`,
		} );
	}

	options.log?.( `Approving WordPress.com import plan ${ preview.plan_hash }...` );
	await request< Session >(
		endpoint( options.destination, `/${ encodeURIComponent( session.session_id ) }/approve` ),
		options.token,
		{ method: 'POST', body: JSON.stringify( { plan_hash: preview.plan_hash } ) }
	);
	const finished = await waitForState( options.destination, options.token, session.session_id, 'finished' );
	if ( ! finished.site_url || finished.receipt?.success !== true ) {
		throw new PublishError( {
			code: 'receipt_incomplete',
			message: 'WordPress.com returned an incomplete import receipt.',
		} );
	}

	return {
		target: 'wpcom',
		liveUrl: finished.site_url,
		files: entries.length,
		bytes: archive.length,
		notes: [ `session ${ session.session_id }`, `artifact sha256 ${ digest }` ],
	};
}

export const wpcomTarget: PublishTarget = {
	name: 'wpcom',
	publish: publishToWpcom,
};
