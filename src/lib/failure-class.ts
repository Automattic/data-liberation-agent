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

/**
 * Whether `error` must fail the capture rather than degrade the unit that raised
 * it: declared integrity errors and programmer errors. Any other error is
 * confined to the unit that threw it.
 */
export function isIntegrityError( error: unknown ): boolean {
	return error instanceof IntegrityError || error instanceof TypeError || error instanceof ReferenceError ||
		error instanceof RangeError || error instanceof SyntaxError || error instanceof EvalError || ! ( error instanceof Error );
}
