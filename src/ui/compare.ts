// src/ui/compare.ts
//
// `data-liberation compare <dir>`: browser-compare the liberated copy to its
// source at widths capture never sampled. `--screenshots` writes PNG evidence
// and never decides pass/fail. `--candidate <url>` compares another rendered
// copy of the site, such as one built from the capture, instead.
//
import { checkFidelity, type FidelityReport } from '../lib/fidelity/check.js';
import type { MotionContract } from '../lib/fidelity/candidate-motion.js';
import { summariseFindings } from '../lib/fidelity/self-consistency.js';

export async function runCompare(
	directory: string,
	options: { screenshots?: boolean; candidateUrl?: string; motionContract?: MotionContract; stage?: import('../lib/fidelity/reference.js').FidelityStage } = {}
): Promise< FidelityReport > {
	const report = await checkFidelity( {
		directory,
		screenshots: options.screenshots,
		candidateUrl: options.candidateUrl,
		motionContract: options.motionContract,
		stage: options.stage,
		log: ( message ) => process.stderr.write( `${ message }\n` ),
	} );

	// Tier one, over every route.
	const consistency = report.selfConsistency;
	if ( consistency.pass ) {
		process.stdout.write( `self-consistency ok across ${ consistency.routes } route(s)\n` );
	} else {
		for ( const group of summariseFindings( consistency.findings ) ) {
			process.stdout.write(
				`self-consistency FAIL ${ group.kind }: ${ group.routes } route(s) — ${ group.examples.join(
					'; '
				) }\n`
			);
		}
	}

	// Tier two, over the sampled routes.
	for ( const item of report.pending ?? [] ) process.stdout.write( `${ item.stage } ${ item.route } ${ item.viewport }px ${ item.state } UNPROVEN: ${ item.reason }\n` );
	for ( const score of report.scores ) {
		const mark = score.pass ? 'ok' : 'FAIL';
		process.stdout.write( `${ score.stage ?? report.stage ?? 'drift' } ${ score.route } ${ score.viewport }px ${ score.state ?? 'baseline' } ${ mark }` );
		if ( ! score.pass ) process.stdout.write( `: ${ score.failures.join( '; ' ) }` );
		if ( score.notes.length ) process.stdout.write( `  (${ score.notes.join( '; ' ) })` );
		process.stdout.write( '\n' );
	}
	for ( const evidence of report.motionEvidence ?? [] ) {
		process.stdout.write( `${ evidence.route } ${ evidence.viewport }px source/${ report.portableMotion ? 'authored portable capture' : 'candidate' } interaction ${ evidence.pass ? 'ok' : `FAIL: ${ evidence.failures.join( '; ' ) }` } (raw captured script: removed)\n` );
	}

	// Say what was measured, not just how it went. "Passed" over an unstated
	// scope is how a sampled check gets read as a whole-site result.
	const unproven = report.routesCleanupUnproven.length
		? `, ${ report.routesCleanupUnproven.length } not compared because their capture cleanup is unproven (${ report.routesCleanupUnproven.join( ', ' ) })`
		: '';
	const scope = `${ consistency.routes } route(s) checked offline, ${ report.routes.length } of ${ report.routesAvailable } in ${ report.stage ?? 'drift' } scope${ unproven }`;
	if ( report.coverage ) process.stdout.write( `Coverage: ${ report.coverage.measured }/${ report.coverage.required } required cells; ${( report.pending ?? [] ).length} pending; ${ report.coverage.unknowns.join( '; ' ) }\n` );
	process.stdout.write(
		report.pass
			? `Passed: ${ scope }, against ${ report.sourceUrl }\n`
			: `${ report.status === 'unproven' ? 'Unproven' : 'Failed' }: ${ report.failed } fidelity check(s) and ${ consistency.findings.length } offline finding(s): ${ scope }, source identity ${ report.sourceUrl }\n`
	);
	return report;
}
