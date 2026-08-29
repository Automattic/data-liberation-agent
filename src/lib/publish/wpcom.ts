import { createHash } from 'node:crypto';
import { collectDirectoryEntries, createZipArchive } from './zip.js';
import { PublishError, type PublishOptions, type PublishResult, type PublishTarget } from './types.js';

const API_BASE = 'https://public-api.wordpress.com/wpcom/v2/sites';
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 300;

interface Session {
	session_id: string;
	state: string;
	source_digest?: string;
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
	let session: Session;
	if ( options.session ) {
		options.log?.( `Resuming WordPress.com import session ${ options.session }...` );
		session = await request< Session >(
			endpoint( options.destination, `/${ encodeURIComponent( options.session ) }` ),
			options.token
		);
		if ( session.source_digest && session.source_digest !== digest ) {
			throw new PublishError( {
				code: 'session_source_mismatch',
				message: `WordPress.com session ${ session.session_id } belongs to a different site archive.`,
			} );
		}
	} else {
		options.log?.( `Creating WordPress.com import session for ${ options.destination }...` );
		session = await request< Session >( endpoint( options.destination ), options.token, {
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
	}

	if ( session.state === 'failed' ) {
		throw new PublishError( {
			code: String( session.receipt?.code ?? 'wpcom_import_failed' ),
			message: `WordPress.com import session ${ session.session_id } failed.`,
		} );
	}
	if ( session.state === 'awaiting_upload' ) {
		if ( ! session.upload ) {
			const uploadGrant = await request< Session >(
				endpoint( options.destination, `/${ encodeURIComponent( session.session_id ) }/upload-token` ),
				options.token,
				{ method: 'POST', body: '{}' }
			);
			session = { ...session, ...uploadGrant };
		}
		if ( ! session.upload ) {
			throw new PublishError( {
				code: 'upload_grant_missing',
				message: 'WordPress.com did not return an upload grant.',
			} );
		}
		options.log?.( `Uploading ${ entries.length } files (${ archive.length } archive bytes)...` );
		await uploadArtifact( session.upload, archive );
		const uploadComplete = await request< Session >(
			endpoint( options.destination, `/${ encodeURIComponent( session.session_id ) }/upload-complete` ),
			options.token,
			{ method: 'POST', body: '{}' }
		);
		session = { ...session, ...uploadComplete };
	}

	if ( [ 'capture_queued', 'artifact_queued', 'compiling' ].includes( session.state ) ) {
		options.log?.( 'Waiting for the WordPress.com import plan...' );
		session = await waitForState( options.destination, options.token, session.session_id, 'preview_ready' );
	}
	if ( session.state === 'preview_ready' ) {
		if ( ! session.plan_hash ) {
			throw new PublishError( {
				code: 'plan_hash_missing',
				message: 'WordPress.com preview did not return a plan hash.',
			} );
		}
		if ( ! options.approve ) {
			throw new PublishError( {
				code: 'approval_required',
				message: `WordPress.com plan ${ session.plan_hash } is ready; rerun with --session ${ session.session_id } --yes to approve it.`,
			} );
		}
		options.log?.( `Approving WordPress.com import plan ${ session.plan_hash }...` );
		const approved = await request< Session >(
			endpoint( options.destination, `/${ encodeURIComponent( session.session_id ) }/approve` ),
			options.token,
			{ method: 'POST', body: JSON.stringify( { plan_hash: session.plan_hash } ) }
		);
		session = { ...session, ...approved };
	}
	if ( [ 'queued', 'applying' ].includes( session.state ) ) {
		options.log?.( 'Waiting for the WordPress.com import to finish...' );
		session = await waitForState( options.destination, options.token, session.session_id, 'finished' );
	}
	if ( session.state !== 'finished' ) {
		throw new PublishError( {
			code: 'invalid_session_state',
			message: `WordPress.com import session ${ session.session_id } cannot continue from state ${ session.state }.`,
		} );
	}
	if ( ! session.site_url || session.receipt?.success !== true ) {
		throw new PublishError( {
			code: 'receipt_incomplete',
			message: 'WordPress.com returned an incomplete import receipt.',
		} );
	}

	return {
		target: 'wpcom',
		liveUrl: session.site_url,
		files: entries.length,
		bytes: archive.length,
		notes: [ `session ${ session.session_id }`, `artifact sha256 ${ digest }` ],
	};
}

export const wpcomTarget: PublishTarget = {
	name: 'wpcom',
	publish: publishToWpcom,
};
