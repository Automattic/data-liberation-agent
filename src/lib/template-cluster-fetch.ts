import { safeFetch, type SafeFetchResult } from './media-fetch/safe-fetch.js';
import type { SourceRequestGovernors } from './source-request-governor.js';

/** Queueing and Retry-After consume the capture budget, not an attempt's network timeout. */
export async function fetchTemplateDocument( url: string, options: {
	governors: SourceRequestGovernors;
	/** Absolute capture deadline; standalone callers get a bounded two-minute fetch budget. */
	deadline?: number;
	timeoutMs: number;
	userAgent?: string;
} ): Promise< SafeFetchResult > {
	const signal = AbortSignal.timeout( Math.max( 0, Math.ceil( ( options.deadline ?? Date.now() + 120_000 ) - Date.now() ) ) );
	const governor = options.governors.forOrigin( url );
	// Only attempt timeouts are retryable here. Scope, size and permanent HTTP
	// failures retain their existing meaning; throttles belong to the governor.
	for ( let attempt = 1; ; attempt++ ) {
		try {
			const { response } = await governor.run( () => safeFetch( url, {
				governors: null, signal, timeoutMs: options.timeoutMs,
				...( options.userAgent ? { headers: { 'User-Agent': options.userAgent } } : {} ),
			} ), { signal, attribution: { phase: 'template-clusters', url } } );
			return response;
		} catch ( error ) {
			if ( signal.aborted || attempt >= 3 || ! ( error instanceof Error ) || error.name !== 'TimeoutError' ) throw error; // failure-class: operational
		}
	}
}
