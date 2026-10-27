// src/lib/publish/types.ts
//
// The publish boundary. A target receives a directory of liberated HTML and
// returns where it went live. Nothing about a specific host belongs in the
// liberation core — targets depend on the HTML contract, never the reverse.
//
export interface PublishOptions {
	/** Directory to publish. Its contents become the site root. */
	directory: string;
	/** Credential for an owned publish. Anonymous when omitted. For an
	 * anonymous space, the space's claim key is the bearer that may publish
	 * into it. */
	token?: string | undefined;
	/** Existing destination space to add a version to, instead of creating a
	 * new one. Targets that do not republish into a space ignore it. */
	space?: string | undefined;
	log?: ( ( message: string ) => void ) | undefined;
}

export interface PublishResult {
	target: string;
	/** Stable URL for the published site. */
	liveUrl: string;
	/** Identifier of the destination space that received this publish, when the
	 * target reports one. Pass it as `space` — with `token` for an owned space,
	 * or the anonymous space's claim key — to add the next version to it. */
	spaceId?: string | undefined;
	/** URL for this exact version, when the target versions publishes. */
	versionUrl?: string | undefined;
	/** File count and total bytes archived and sent in the request. A target
	 * that reports storage outcomes separately may store fewer — see `accepted`. */
	files: number;
	bytes: number;
	/**
	 * Files the destination actually stored, when it reports that separately
	 * from what was sent. Undefined when the target gives no such breakdown,
	 * in which case `files` is the only figure available.
	 */
	accepted?: number | undefined;
	/** Archive paths the destination reports it declined to store, when it
	 * names them. A non-empty list means the live site is missing content
	 * that the archive carried. */
	ignored?: string[] | undefined;
	/**
	 * What an anonymous publish returns for keeping the space: the one-time
	 * link that transfers ownership, its deadline, the claim key that may
	 * publish into the space again, and the link that previews it while it is
	 * still private. Present only when the target created an unclaimed space.
	 */
	claim?: {
		/** The claim link, from the receipt's `claimUrl`. */
		url?: string | undefined;
		expiresAt?: string | undefined;
		/** Secret that may publish into the anonymous space again; pass it as
		 * `token` alongside `space` to add a version. */
		key?: string | undefined;
		/** Link that opens the private space before it is claimed. */
		previewUrl?: string | undefined;
	} | undefined;
	/** True when the target reports the site is not publicly readable yet. */
	private?: boolean | undefined;
	/** Target-specific notes worth showing the operator. */
	notes: string[];
}

export interface PublishTarget {
	name: string;
	/** Optional destination attribution. Receives an isolated staging copy;
	 * the canonical liberated artifact remains attribution-free and unchanged. */
	attribution?(options: { directory: string }): Promise<void>;
	publish( options: PublishOptions ): Promise< PublishResult >;
}

export class PublishError extends Error {
	readonly code: string;
	readonly requestId: string | undefined;

	constructor( input: { code: string; message: string; requestId?: string | undefined } ) {
		super( input.message );
		this.name = 'PublishError';
		this.code = input.code;
		this.requestId = input.requestId;
	}
}
