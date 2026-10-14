import type { RouteDiagnostic } from './capture-export-routes.js';

/**
 * Per-file cap on what export writes into `website/` (`maxFileBytes`).
 *
 * The default is coupled to Static Site Importer's per-file intake limit for
 * staged archives (`max_entry_uncompressed_bytes`, 50 MiB): a file over it is
 * refused at import, so exporting it only moves the failure downstream. Capture
 * itself accepts larger media (videos up to `MAX_CAPTURED_VIDEO_RESOURCE_BYTES`).
 * Change both together.
 */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * One total byte budget for the whole exported `website/` tree (`websiteTotalBytes`).
 *
 * The default sits under Static Site Importer's staged archive intake
 * (250 MiB uncompressed, `static_site_importer_staged_archive_limits()`) and
 * leaves headroom for the remaining artifact. Media and resources spend it
 * together, required bytes first. Change importer and default together.
 */
export const DEFAULT_WEBSITE_TOTAL_BYTES = 240 * 1024 * 1024;

/** A captured asset over `maxFileBytes`: not written; its references stay unresolved. */
export const ASSET_EXCEEDS_FILE_LIMIT = 'asset_exceeds_file_limit';

/** A captured asset whose bytes do not fit the portable export budget. */
export const ASSET_EXCEEDS_BUDGET = 'asset_exceeds_budget';

export function validateMaxFileBytes( maxFileBytes: unknown ): void {
	if ( maxFileBytes !== undefined && ( typeof maxFileBytes !== 'number' || ! Number.isSafeInteger( maxFileBytes ) || maxFileBytes < 1 ) )
		throw new RangeError( 'maxFileBytes must be a positive integer number of bytes' );
}

export function assetExceedsFileLimit( url: string, bytes: number, limit: number ): RouteDiagnostic {
	return {
		code: ASSET_EXCEEDS_FILE_LIMIT, url, unit: 'asset', severity: 'warning',
		reason: `captured asset is ${ bytes } bytes, over the ${ limit }-byte per-file export limit; not written and its references left unresolved`,
		metrics: { bytes, limit },
	};
}

export function assetExceedsBudget( url: string, bytes: number, limit: number ): RouteDiagnostic {
	return {
		code: ASSET_EXCEEDS_BUDGET, url, unit: 'asset', severity: 'warning',
		reason: `captured asset is ${ bytes } bytes, over the ${ limit }-byte portable export budget; not written and its references left unresolved`,
		metrics: { bytes, limit },
	};
}

/** Page documents over the limit fail their route (contained as `route_export_failed`). */
export function assertPageWithinFileLimit( html: string, limit: number ): void {
	const bytes = Buffer.byteLength( html );
	// failure-class: representability:route
	if ( bytes > limit ) throw new Error( `exported page document is ${ bytes } bytes, over the ${ limit }-byte per-file export limit` );
}
