/**
 * A violation of containment, identity or hash evidence, or of a security
 * boundary. It fails the capture closed; it is never contained to one route.
 */
export class IntegrityError extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'IntegrityError';
	}
}

/** `.catch( orElse( fallback ) )`: operational failures yield the fallback; integrity errors still throw. */
export const orElse = <T>( fallback: T ) => ( error: unknown ): T => {
	if ( isIntegrityError( error ) ) throw error; // failure-class: integrity
	return fallback;
};

/**
 * Whether `error` must fail the capture rather than degrade the unit that raised
 * it: declared integrity errors and programmer errors. Any other error is
 * confined to the unit that threw it.
 */
export function isIntegrityError( error: unknown ): boolean {
	return error instanceof IntegrityError || error instanceof TypeError || error instanceof ReferenceError ||
		error instanceof RangeError || error instanceof SyntaxError || error instanceof EvalError || ! ( error instanceof Error );
}
