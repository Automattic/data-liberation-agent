// src/ui/compare.ts
//
// `data-liberation compare <dir>`: browser-compare the liberated copy to its
// source at widths capture never sampled. `--screenshots` writes PNG evidence
// and never decides pass/fail.
//
import { checkFidelity, type FidelityReport } from '../lib/fidelity/check.js';

export async function runCompare(
	directory: string,
	options: { screenshots?: boolean } = {}
): Promise< FidelityReport > {
	const report = await checkFidelity( {
		directory,
		screenshots: options.screenshots,
		log: ( message ) => process.stderr.write( `${ message }\n` ),
	} );

	for ( const score of report.scores ) {
		const mark = score.pass ? 'ok' : 'FAIL';
		process.stdout.write( `${ score.viewport }px ${ mark }` );
		if ( ! score.pass ) process.stdout.write( `: ${ score.failures.join( '; ' ) }` );
		if ( score.notes.length ) process.stdout.write( `  (${ score.notes.join( '; ' ) })` );
		process.stdout.write( '\n' );
	}
	process.stdout.write(
		report.pass
			? `Passed ${ report.passed } viewport(s) against ${ report.sourceUrl }\n`
			: `Failed ${ report.failed }/${ report.passed + report.failed } viewport(s) against ${ report.sourceUrl }\n`
	);
	return report;
}
