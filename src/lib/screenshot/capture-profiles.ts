import type { BrowserContextOptions } from 'playwright';

/** Public rendering identity only. Authentication and transport options are not replay metadata. */
export type ReplayBrowserIdentity = Pick<BrowserContextOptions, 'userAgent' | 'isMobile' | 'hasTouch' | 'deviceScaleFactor' | 'locale' | 'timezoneId' | 'colorScheme' | 'reducedMotion' | 'screen'>;

export function replayBrowserIdentity( options: BrowserContextOptions ): ReplayBrowserIdentity {
	const identity: ReplayBrowserIdentity = {};
	for ( const key of [ 'userAgent', 'isMobile', 'hasTouch', 'deviceScaleFactor', 'locale', 'timezoneId', 'colorScheme', 'reducedMotion' ] as const ) {
		if ( options[ key ] !== undefined ) Object.assign( identity, { [ key ]: options[ key ] } );
	}
	if ( options.screen ) identity.screen = { width: options.screen.width, height: options.screen.height };
	return identity;
}

/** A source document's browser identity. The adapter owns device names/UA recipes. */
export interface CaptureProfile {
	id: string;
	width: number;
	height: number;
	/** Resolved through Playwright's public devices map at capture time. */
	device?: string;
	context?: ReplayBrowserIdentity;
	referenceWidths?: number[];
	learnFluid?: boolean;
}

/** Keep even JS callers' undeclared transport/auth fields out of stored recipes. */
export function publicCaptureProfile( profile: CaptureProfile ): CaptureProfile {
	return { id: profile.id, width: profile.width, height: profile.height,
		...( profile.device === undefined ? {} : { device: profile.device } ),
		...( profile.context === undefined ? {} : { context: replayBrowserIdentity( profile.context ) } ),
		...( profile.referenceWidths === undefined ? {} : { referenceWidths: [ ...profile.referenceWidths ] } ),
		...( profile.learnFluid === undefined ? {} : { learnFluid: profile.learnFluid } ),
	};
}

export function validateCaptureProfile( profile: CaptureProfile ): void {
	if ( ! /^[a-z][a-z0-9-]*$/.test( profile.id ) || ! Number.isInteger( profile.width ) || profile.width <= 0 ||
		! Number.isInteger( profile.height ) || profile.height <= 0 ||
		profile.referenceWidths?.length === 0 ||
		profile.referenceWidths?.some( width => ! Number.isInteger( width ) || width <= 0 ) ) throw new Error( 'Invalid source capture profile' );
}
