// src/ui/compare.ts
//
// `data-liberation compare <dir>`: browser-compare the liberated copy to its
// frozen capture-session source. `--screenshots` writes PNG evidence and never
// decides pass/fail. `--candidate <url>` compares portable capture to candidate;
// only explicit `--stage drift` revisits the live source at unsampled widths.
//
import { checkFidelity, type FidelityReport } from '../lib/fidelity/check.js';
import type { MotionContract } from '../lib/fidelity/candidate-motion.js';
import { summariseFindings } from '../lib/fidelity/self-consistency.js';

export async function runCompare(
	directory: string,
	options: { screenshots?: boolean; candidateUrl?: string; motionContract?: MotionContract; profiles?: string[]; stage?: import('../lib/fidelity/reference.js').FidelityStage; log?: (message: string) => void; write?: (message: string) => void } = {}
): Promise< FidelityReport > {
	const write = options.write ?? ((message: string) => { process.stdout.write(message); });
	const report = await checkFidelity( {
		directory,
		screenshots: options.screenshots,
		candidateUrl: options.candidateUrl,
		motionContract: options.motionContract,
		stage: options.stage,
		profiles: options.profiles,
		log: options.log ?? (( message ) => process.stderr.write( `${ message }\n` )),
	} );

	// Tier one, over every route.
	const consistency = report.selfConsistency;
	if ( consistency.pass ) {
		write( `self-consistency ok across ${ consistency.routes } route(s)\n` );
	} else {
		for ( const group of summariseFindings( consistency.findings ) ) {
			write(
				`self-consistency FAIL ${ group.kind }: ${ group.routes } route(s) — ${ group.examples.join(
					'; '
				) }\n`
			);
		}
	}

	// Tier two, over the sampled routes.
	for ( const item of report.pending ?? [] ) write( `${ item.stage } ${ item.route } ${ item.profile ? `${ item.profile } ` : '' }${ item.viewport }px ${ item.state } UNPROVEN: ${ item.reason }\n` );
	for ( const score of report.scores ) {
		const mark = score.pass ? 'ok' : 'FAIL';
		write( `${ score.stage ?? report.stage ?? 'drift' } ${ score.route } ${ score.profile ? `${ score.profile } ` : '' }${ score.viewport }px ${ score.state ?? 'baseline' } ${ mark }` );
		if ( ! score.pass ) write( `: ${ score.failures.join( '; ' ) }` );
		if ( score.notes.length ) write( `  (${ score.notes.join( '; ' ) })` );
		write( '\n' );
	}
	for ( const evidence of report.motionEvidence ?? [] ) {
		write( `${ evidence.route } ${ evidence.viewport }px source/${ report.portableMotion ? `${ report.portableMotion.origin } portable capture` : 'candidate' } interaction ${ evidence.pass ? 'ok' : `FAIL: ${ evidence.failures.join( '; ' ) }` } (raw captured script: removed)\n` );
	}

	// Say what was measured, not just how it went. "Passed" over an unstated
	// scope is how a sampled check gets read as a whole-site result.
	const unproven = report.routesCleanupUnproven.length
		? `, ${ report.routesCleanupUnproven.length } not compared because their capture cleanup is unproven (${ report.routesCleanupUnproven.join( ', ' ) })`
		: '';
	const scope = `${ consistency.routes } route(s) checked offline, ${ report.routes.length } of ${ report.routesAvailable } in ${ report.stage ?? 'drift' } scope${ unproven }`;
	if ( report.coverage ) write( `Coverage: ${ report.coverage.measured }/${ report.coverage.required } required cells; ${( report.pending ?? [] ).length} pending; ${ report.coverage.unknowns.join( '; ' ) }\n` );
	write(
		report.pass
			? `Passed: ${ scope }, against ${ report.sourceUrl }\n`
			: `${ report.status === 'unproven' ? 'Unproven' : 'Failed' }: ${ report.failed } fidelity check(s) and ${ consistency.findings.length } offline finding(s): ${ scope }, source identity ${ report.sourceUrl }\n`
	);
	return report;
}
