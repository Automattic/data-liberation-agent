import { learnFluidModel, learnSegmentedFluidModel, segmentedCss, type GeometrySample } from './fluid-model.js';

/** Only pixel basic shapes with stable syntax can be replaced coordinate by coordinate. */
export function parseClipPath( value: string ): { template: string; values: number[]; vertical: boolean[] } | null {
	const shape = /^(polygon|inset|rect)\((.*)\)$/.exec( value.trim() );
	if ( ! shape ) return null;
	const name = shape[ 1 ]!, body = shape[ 2 ]!;
	const values: number[] = [];
	const template = body.replace( /-?(?:\d*\.)?\d+(?:px)?/g, token => {
		if ( ! token.endsWith( 'px' ) && Number( token ) !== 0 ) return token;
		values.push( parseFloat( token ) );
		return '@';
	} );
	const coordinates = template.replace( /^(?:evenodd|nonzero),\s*/, '' );
	if ( /[^@\s,]/.test( coordinates ) ) return null;
	const count = values.length;
	if ( name === 'polygon' ? count < 6 || count % 2 !== 0 || ! coordinates.split( ',' ).every( point => point.trim().split( /\s+/ ).join( '' ) === '@@' ) : name === 'rect' ? count !== 4 : count < 1 || count > 4 ) return null;
	return { template: `${ name }(${ template })`, values, vertical: values.map( ( _, index ) => name === 'polygon' ? index % 2 === 1 : index % 2 === 0 ) };
}

/** Fit the entire shape atomically; never ship a partially learned polygon. */
export function learnClipPath( template: string, series: GeometrySample[][], selector: string, prefix: string ): { css: string; rules: string; kinds: string[] } | null {
	const expressions: string[] = [], rules: string[] = [], kinds: string[] = [];
	for ( const [ index, samples ] of series.entries() ) {
		if ( samples.some( sample => ! Number.isFinite( sample.value ) ) ) return null;
		const model = learnFluidModel( samples );
		if ( model.kind !== 'breakpoint' ) {
			expressions.push( `calc(${ model.css })` );
			kinds.push( model.kind );
			continue;
		}
		const segmented = learnSegmentedFluidModel( samples );
		if ( ! segmented ) return null;
		const property = `--${ prefix }-${ index }`;
		rules.push( segmentedCss( selector, property, segmented.segments ) );
		expressions.push( `calc(var(${ property }))` );
		kinds.push( 'segmented' );
	}
	let index = 0;
	return { css: template.replace( /@/g, () => expressions[ index++ ]! ), rules: rules.join( '\n' ), kinds };
}
