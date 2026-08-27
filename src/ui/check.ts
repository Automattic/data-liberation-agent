// src/ui/check.ts
//
// `data-liberation check <dir>`: prove the liberated copy matches the source
// at widths capture never sampled.
//
import { checkFidelity, type FidelityReport } from '../lib/fidelity/check.js';

export async function runCheck( directory: string ): Promise< FidelityReport > {
	const report = await checkFidelity( {
		directory,
		log: ( message ) => process.stderr.write( `${ message }\n` ),
	} );

	for ( const score of report.scores ) {
		const mark = score.pass ? 'ok' : 'FAIL';
		process.stdout.write( `${ score.viewport }px ${ mark }` );
		if ( ! score.pass ) process.stdout.write( `: ${ score.failures.join( '; ' ) }` );
		process.stdout.write( '\n' );
	}
	process.stdout.write(
		report.pass
			? `Passed ${ report.passed } viewport(s) against ${ report.sourceUrl }\n`
			: `Failed ${ report.failed }/${ report.passed + report.failed } viewport(s) against ${ report.sourceUrl }\n`
	);
	return report;
}
