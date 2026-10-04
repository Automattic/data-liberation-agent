import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import {
	EXPORT_PUBLICATION_BOUNDARIES,
	EXPORT_PUBLICATION_HOLD,
	EXPORT_PUBLICATION_KILL,
	EXPORT_PUBLICATION_LOCK_SCHEMA,
	EXPORT_PUBLICATION_OWNED,
	ExportPublicationJournalError,
	ExportPublicationRejected,
	exportPublicationJournalBoundary,
	publishExportGeneration,
	recoverExportPublication,
} from './export-publication.js';
import { materializeHttpDocuments } from './http-materialization.js';
import { SectionSpecsStore } from './replicate/section-specs-store.js';
import { FaultInjected, armFault, clearFaults, disarmFault } from './resume-state/faultpoint.js';
import { INTERACTION_STATES_SCHEMA } from './screenshot/interaction-capture.js';
import { SCROLL_STATES_SCHEMA } from './screenshot/scroll-state-capture.js';
import { cleanupPolicy } from './source-cleanup.js';

const dirs: string[] = [];
const sourceUrl = 'https://example.com/';

afterEach( () => {
	clearFaults();
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

describe( 'export publication', () => {
	it( 'keeps a successful export byte-identical and free of staging identities', () => {
		const outputDir = captureFixture( '<main><h1>Home</h1></main>' );
		const first = exportWebsiteCapture( exportOptions( outputDir ) );
		const before = snapshot( outputDir );
		const second = exportWebsiteCapture( exportOptions( outputDir ) );
		expect( second ).toBe( join( outputDir, 'capture-receipt.json' ) );
		expect( first ).toBe( second );
		expect( snapshot( outputDir ) ).toEqual( before );
		const receipt = JSON.parse( readFileSync( first, 'utf8' ) );
		expect( receipt.schema ).toBe( 'data-liberation/capture-receipt/v1' );
		expect( receipt.websiteRoot ).toBe( 'website' );
		expect( receipt.entrypoint ).toBe( 'website/index.html' );
		expect( existsSync( join( outputDir, '.export-publication.lock' ) ) ).toBe( false );
		expect( existsSync( join( outputDir, '.export-publication' ) ) ).toBe( false );
		expect( existsSync( join( outputDir, '.capture-export-html' ) ) ).toBe( false );
		assertNoStageIdentity( outputDir );
		expect( readFileSync( join( outputDir, 'resources', 'kept.txt' ), 'utf8' ) ).toBe( 'capture-resource' );
		expect( readFileSync( join( outputDir, 'source-behavior.json' ), 'utf8' ) ).toBe( '{"unowned":true}\n' );
	} );

	it( 'leaves no public website or receipt when the first export fails, then retries', () => {
		const outputDir = captureFixture( '<main><h1>Home</h1></main>' );
		for ( const boundary of [
			EXPORT_PUBLICATION_BOUNDARIES.beforeStage,
			EXPORT_PUBLICATION_BOUNDARIES.afterHtml,
			EXPORT_PUBLICATION_BOUNDARIES.sidecarWrite,
			EXPORT_PUBLICATION_BOUNDARIES.duringPublish,
			EXPORT_PUBLICATION_BOUNDARIES.beforeReceipt,
			EXPORT_PUBLICATION_BOUNDARIES.receiptApplied,
		] ) {
			expectFault( boundary, () => exportWebsiteCapture( exportOptions( outputDir ) ) );
			for ( const owned of EXPORT_PUBLICATION_OWNED ) {
				expect( existsSync( join( outputDir, owned.path ) ), `${ boundary }: ${ owned.path }` ).toBe( false );
			}
			expect( existsSync( join( outputDir, '.export-publication.lock' ) ) ).toBe( false );
		}
		exportWebsiteCapture( exportOptions( outputDir ) );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( 'Home' );
		expect( existsSync( join( outputDir, 'capture-receipt.json' ) ) ).toBe( true );
	} );

	it( 'restores the previous generation at each pre-commit boundary and retries', () => {
		const outputDir = captureFixture( '<main><h1>Original</h1></main>' );
		exportWebsiteCapture( exportOptions( outputDir ) );
		writeFileSync( join( outputDir, 'interaction-states.json' ), '{"stale":true}\n' );
		const before = snapshot( outputDir );
		for ( const boundary of [
			EXPORT_PUBLICATION_BOUNDARIES.afterHtml,
			EXPORT_PUBLICATION_BOUNDARIES.sidecarWrite,
			EXPORT_PUBLICATION_BOUNDARIES.duringPublish,
			EXPORT_PUBLICATION_BOUNDARIES.beforeReceipt,
		] ) {
			writeFileSync( join( outputDir, 'html', 'homepage.html' ), `<main><h1>${ boundary }</h1></main>` );
			expectFault( boundary, () => exportWebsiteCapture( exportOptions( outputDir ) ) );
			expect( snapshot( outputDir ) ).toEqual( before );
			expect( readFileSync( join( outputDir, 'html', 'homepage.html' ), 'utf8' ) ).toContain( boundary );
			expect( readFileSync( join( outputDir, 'resources', 'kept.txt' ), 'utf8' ) ).toBe( 'capture-resource' );
		}
		writeFileSync( join( outputDir, 'html', 'homepage.html' ), '<main><h1>Original</h1></main>' );
		exportWebsiteCapture( exportOptions( outputDir ) );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( 'Original' );
		expect( existsSync( join( outputDir, 'interaction-states.json' ) ) ).toBe( false );
	} );

	it( 'keeps the committed generation when a fault lands after the receipt boundary', () => {
		const outputDir = captureFixture( '<main><h1>Original</h1></main>' );
		exportWebsiteCapture( exportOptions( outputDir ) );
		writeFileSync( join( outputDir, 'html', 'homepage.html' ), '<main><h1>Committed</h1></main>' );
		expectFault( EXPORT_PUBLICATION_BOUNDARIES.afterReceipt, () => exportWebsiteCapture( {
			...exportOptions( outputDir ),
			title: 'committed-generation',
		} ) );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( 'Committed' );
		expect( JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ).title ).toBe(
			'committed-generation',
		);
		expect( existsSync( join( outputDir, '.export-publication.lock' ) ) ).toBe( false );
		expect( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ).toContain( 'homepage.html' );
	} );

	it( 'removes only stale export-owned optional outputs', () => {
		const outputDir = captureFixture(
			'<html><body><main><div data-dla-geometry-id="wrapper-0"><section data-dla-geometry-id="target-0">Copy</section></div></main></body></html>',
		);
		mkdirSync( join( outputDir, 'layout-geometry' ), { recursive: true } );
		const observation = {
			schema: 'data-liberation/layout-geometry-capture/v1',
			observations: [ {
				wrapperIdentity: 'wrapper-0',
				targetIdentity: 'target-0',
				viewport: 1440,
				state: 'default',
				wrapper: { x: 0, y: 0, width: 100, height: 24 },
				target: { x: 0, y: 0, width: 100, height: 24 },
				simulated: { x: 0, y: 0, width: 100, height: 24 },
				facts: { display: 'block', position: 'static', visibility: 'visible', childCount: 1 },
				invariants: { runtime: true, semantics: true },
			} ],
			omissions: {},
		};
		writeFileSync( join( outputDir, 'layout-geometry', 'homepage.desktop.json' ), JSON.stringify( observation ) );
		writeFileSync( join( outputDir, 'layout-geometry', 'homepage.mobile.json' ), JSON.stringify( {
			...observation,
			observations: [ { ...observation.observations[ 0 ], viewport: 390 } ],
		} ) );
		SectionSpecsStore.load( outputDir ).set( sourceUrl, [ {
			selector: 'main',
			headings: [ 'Copy' ],
			images: [],
			layout: {},
		} as never ], [] );
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) );
		manifest.entries[ sourceUrl ].interactions = {
			schema: INTERACTION_STATES_SCHEMA,
			states: [],
			initialDialogs: [],
		};
		writeFileSync( join( outputDir, 'screenshots', 'manifest.json' ), JSON.stringify( manifest ) );
		exportWebsiteCapture( exportOptions( outputDir ) );
		expect( existsSync( join( outputDir, 'layout-geometry-proof.json' ) ) ).toBe( true );
		expect( existsSync( join( outputDir, 'semantic-evidence.index.json' ) ) ).toBe( true );
		expect( existsSync( join( outputDir, 'semantic-evidence' ) ) ).toBe( true );
		expect( existsSync( join( outputDir, 'interaction-states.json' ) ) ).toBe( true );
		const observationBytes = readFileSync( join( outputDir, 'layout-geometry', 'homepage.desktop.json' ) );
		const resourceBytes = readFileSync( join( outputDir, 'resources', 'kept.txt' ) );
		writeFileSync( join( outputDir, 'layout-geometry', 'homepage.desktop.json' ), '{"schema":"invalid"}' );
		writeFileSync( join( outputDir, 'layout-geometry', 'homepage.mobile.json' ), '{"schema":"invalid"}' );
		SectionSpecsStore.load( outputDir ).set( sourceUrl, [ {} as never ], [] );
		delete manifest.entries[ sourceUrl ].interactions;
		writeFileSync( join( outputDir, 'screenshots', 'manifest.json' ), JSON.stringify( manifest ) );
		const manifestBytes = readFileSync( join( outputDir, 'screenshots', 'manifest.json' ) );
		exportWebsiteCapture( exportOptions( outputDir ) );
		expect( existsSync( join( outputDir, 'layout-geometry-proof.json' ) ) ).toBe( false );
		expect( existsSync( join( outputDir, 'semantic-evidence.index.json' ) ) ).toBe( false );
		expect( existsSync( join( outputDir, 'semantic-evidence' ) ) ).toBe( false );
		expect( existsSync( join( outputDir, 'interaction-states.json' ) ) ).toBe( false );
		expect( readFileSync( join( outputDir, 'layout-geometry', 'homepage.desktop.json' ), 'utf8' ) ).toBe( '{"schema":"invalid"}' );
		expect( readFileSync( join( outputDir, 'resources', 'kept.txt' ) ) ).toEqual( resourceBytes );
		expect( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ) ) ).toEqual( manifestBytes );
		expect( observationBytes.length ).toBeGreaterThan( 0 );
		expect( existsSync( join( outputDir, 'website', 'index.html' ) ) ).toBe( true );
		expect( existsSync( join( outputDir, 'capture-receipt.json' ) ) ).toBe( true );
	} );

	it( 'journals every owned name and deletes only those optional outputs', () => {
		const outputDir = tempDir();
		mkdirSync( join( outputDir, 'website' ), { recursive: true } );
		writeFileSync( join( outputDir, 'website', 'index.html' ), 'previous' );
		writeFileSync( join( outputDir, 'capture-receipt.json' ), 'previous-receipt' );
		writeFileSync( join( outputDir, 'interaction-states.json' ), 'stale-interaction' );
		mkdirSync( join( outputDir, 'semantic-evidence' ), { recursive: true } );
		writeFileSync( join( outputDir, 'semantic-evidence', 'shard-0001.json' ), 'stale-shard' );
		writeFileSync( join( outputDir, 'layout-geometry-proof.json' ), 'stale-proof' );
		mkdirSync( join( outputDir, 'screenshots' ), { recursive: true } );
		writeFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'capture-input' );
		writeFileSync( join( outputDir, 'source-behavior.json' ), 'later-capture-step' );
		publishExportGeneration( outputDir, ( stageDir ) => writeGeneration( stageDir, 'next' ) );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toBe( 'next' );
		expect( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ).toContain( '"generation":"next"' );
		expect( existsSync( join( outputDir, 'interaction-states.json' ) ) ).toBe( false );
		expect( existsSync( join( outputDir, 'semantic-evidence' ) ) ).toBe( false );
		expect( existsSync( join( outputDir, 'layout-geometry-proof.json' ) ) ).toBe( false );
		expect( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ).toBe( 'capture-input' );
		expect( readFileSync( join( outputDir, 'source-behavior.json' ), 'utf8' ) ).toBe( 'later-capture-step' );
		expect( existsSync( join( outputDir, '.export-publication' ) ) ).toBe( false );
	} );

	it( 'refuses to publish through a public symlink', () => {
		const outputDir = tempDir();
		const external = tempDir();
		writeFileSync( join( external, 'index.html' ), 'outside' );
		symlinkSync( external, join( outputDir, 'website' ) );
		expect( () => publishExportGeneration( outputDir, ( stageDir ) => writeGeneration( stageDir, 'next' ) ) ).toThrow(
			/refuses a symlink at website/,
		);
		expect( lstatSync( join( outputDir, 'website' ) ).isSymbolicLink() ).toBe( true );
		expect( readFileSync( join( external, 'index.html' ), 'utf8' ) ).toBe( 'outside' );
		expect( existsSync( join( outputDir, 'capture-receipt.json' ) ) ).toBe( false );
	} );

	it( 'preserves the primary error and recovery files when rollback fails', () => {
		const outputDir = captureFixture( '<main><h1>Original</h1></main>' );
		exportWebsiteCapture( exportOptions( outputDir ) );
		const before = snapshot( outputDir );
		writeFileSync( join( outputDir, 'html', 'homepage.html' ), '<main><h1>Partial</h1></main>' );
		armFault( EXPORT_PUBLICATION_BOUNDARIES.duringPublish );
		armFault( EXPORT_PUBLICATION_BOUNDARIES.rollback );
		let caught: unknown;
		try {
			exportWebsiteCapture( exportOptions( outputDir ) );
		} catch ( error ) {
			caught = error;
		} finally {
			disarmFault( EXPORT_PUBLICATION_BOUNDARIES.duringPublish );
			disarmFault( EXPORT_PUBLICATION_BOUNDARIES.rollback );
		}
		expect( caught ).toBeInstanceOf( FaultInjected );
		expect( ( caught as Error ).message ).toContain( EXPORT_PUBLICATION_BOUNDARIES.duringPublish );
		expect( ( caught as { exportPublicationRollbackFailure?: unknown } ).exportPublicationRollbackFailure )
			.toBeInstanceOf( FaultInjected );
		expect( existsSync( join( outputDir, '.export-publication.lock' ) ) ).toBe( true );
		expect( readdirSync( join( outputDir, '.export-publication' ) ).length ).toBeGreaterThan( 0 );
		const recovery = recoverExportPublication( outputDir );
		expect( recovery.outcome ).toBe( 'restored' );
		expect( snapshot( outputDir ) ).toEqual( before );
		expect( readFileSync( join( outputDir, 'html', 'homepage.html' ), 'utf8' ) ).toContain( 'Partial' );
		expect( existsSync( join( outputDir, '.export-publication.lock' ) ) ).toBe( false );
	} );

	it( 'rejects a second export without removing the in-flight stage', async () => {
		const outputDir = captureFixture( '<main><h1>Home</h1></main>' );
		const hold = join( outputDir, 'hold' );
		writeFileSync( hold, 'hold' );
		const child = spawnExport( outputDir, { [ EXPORT_PUBLICATION_HOLD ]: hold, DLA_EXPORT_PUBLICATION_HOLD_MS: '20000' } );
		try {
			await waitFor( () => existsSync( join( outputDir, '.export-publication.lock' ) ) );
			expect( () => exportWebsiteCapture( exportOptions( outputDir ) ) ).toThrow( ExportPublicationRejected );
			try {
				exportWebsiteCapture( exportOptions( outputDir ) );
			} catch ( error ) {
				expect( ( error as Error ).message ).toContain( 'not rematerialized' );
			}
			const lock = JSON.parse( readFileSync( join( outputDir, '.export-publication.lock' ), 'utf8' ) );
			expect( existsSync( join( outputDir, '.export-publication', lock.generation, 'stage' ) ) ).toBe( true );
			expect( existsSync( join( outputDir, 'website' ) ) ).toBe( false );
		} finally {
			if ( existsSync( hold ) ) unlinkSync( hold );
		}
		await child.done;
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( 'Home' );
		expect( existsSync( join( outputDir, '.export-publication.lock' ) ) ).toBe( false );
	}, 30_000 );

	it( 'rejects concurrent HTTP rematerialization instead of starting a second writer', async () => {
		const fixture = httpFixture();
		const hold = join( fixture.outputDir, 'hold' );
		writeFileSync( hold, 'hold' );
		const runner = writeRunner( fixture.outputDir, 'materialize' );
		const child = spawnExport( fixture.outputDir, {
			[ EXPORT_PUBLICATION_HOLD ]: hold,
			DLA_EXPORT_PUBLICATION_HOLD_MS: '20000',
		}, runner );
		try {
			await waitFor( () => existsSync( join( fixture.outputDir, '.export-publication.lock' ) ) );
			expect( () => materializeHttpDocuments( {
				outputDir: fixture.outputDir,
				sourceUrl,
				platform: 'generic',
				desktopVariant: 'desktop',
			} ) ).toThrow( /not rematerialized/ );
			const lock = JSON.parse( readFileSync( join( fixture.outputDir, '.export-publication.lock' ), 'utf8' ) );
			expect( existsSync( join( fixture.outputDir, '.export-publication', lock.generation, 'stage' ) ) ).toBe( true );
		} finally {
			if ( existsSync( hold ) ) unlinkSync( hold );
		}
		await child.done;
		expect( existsSync( join( fixture.outputDir, 'http-acquisition.json' ) ) ).toBe( true );
		expect( existsSync( join( fixture.outputDir, 'website', 'index.html' ) ) ).toBe( true );
		expect( readFileSync( join( fixture.outputDir, 'source-documents', 'home.html' ), 'utf8' ) ).toContain( 'HTTP' );
	}, 30_000 );

	it( 'recovers a hard exit around the journal and receipt boundaries', () => {
		const outputDir = captureFixture( '<main><h1>Original</h1></main>' );
		exportWebsiteCapture( exportOptions( outputDir ) );
		writeFileSync( join( outputDir, 'interaction-states.json' ), 'stale-optional\n' );
		const before = snapshot( outputDir );
		const killed = ( seam: string ) => killExport( outputDir, seam );

		killed( EXPORT_PUBLICATION_BOUNDARIES.beforeStage );
		expect( recoverExportPublication( outputDir ).outcome ).toBe( 'none' );
		expect( snapshot( outputDir ) ).toEqual( before );

		killed( EXPORT_PUBLICATION_BOUNDARIES.journalPlan );
		const lock = JSON.parse( readFileSync( join( outputDir, '.export-publication.lock' ), 'utf8' ) );
		const journal = readFileSync( join( outputDir, '.export-publication', lock.generation, 'journal.jsonl' ), 'utf8' );
		const plan = journal.trim().split( '\n' ).map( ( line ) => JSON.parse( line ) ).find( ( record ) => record.type === 'plan' );
		expect( plan.outputs.map( ( item: { path: string } ) => item.path ) ).toEqual(
			EXPORT_PUBLICATION_OWNED.map( ( item ) => item.path ),
		);
		expect( recoverExportPublication( outputDir ).outcome ).toBe( 'discarded' );
		expect( snapshot( outputDir ) ).toEqual( before );

		killed( exportPublicationJournalBoundary( 'applied', 'website' ) );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( 'Replacement' );
		expect( recoverExportPublication( outputDir ).outcome ).toBe( 'restored' );
		expect( snapshot( outputDir ) ).toEqual( before );

		killed( EXPORT_PUBLICATION_BOUNDARIES.beforeReceipt );
		expect( existsSync( join( outputDir, 'interaction-states.json' ) ) ).toBe( false );
		expect( recoverExportPublication( outputDir ).outcome ).toBe( 'restored' );
		expect( snapshot( outputDir ) ).toEqual( before );
		expect( readFileSync( join( outputDir, 'html', 'homepage.html' ), 'utf8' ) ).toContain( 'Replacement' );

		killed( EXPORT_PUBLICATION_BOUNDARIES.receiptApplied );
		expect( JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ).title ).toBe( 'replacement-generation' );
		expect( recoverExportPublication( outputDir ).outcome ).toBe( 'restored' );
		expect( snapshot( outputDir ) ).toEqual( before );
		expect( JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ).title ).toBeUndefined();

		killed( EXPORT_PUBLICATION_BOUNDARIES.afterReceipt );
		expect( recoverExportPublication( outputDir ).outcome ).toBe( 'finalized' );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( 'Replacement' );
		expect( JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ).title ).toBe( 'replacement-generation' );
		expect( existsSync( join( outputDir, 'interaction-states.json' ) ) ).toBe( false );
		expect( existsSync( join( outputDir, '.export-publication.lock' ) ) ).toBe( false );
		expect( readFileSync( join( outputDir, 'resources', 'kept.txt' ), 'utf8' ) ).toBe( 'capture-resource' );
	}, 90_000 );

	it( 'recovers a dead or reused pid without signaling that process', () => {
		const outputDir = tempDir();
		mkdirSync( join( outputDir, 'website' ), { recursive: true } );
		writeFileSync( join( outputDir, 'website', 'index.html' ), 'previous' );
		const generation = randomUUID();
		const generationDir = join( outputDir, '.export-publication', generation );
		mkdirSync( join( generationDir, 'backups' ), { recursive: true } );
		writeFileSync( join( generationDir, 'backups', 'website-marker' ), 'unused' );
		renameSync( join( outputDir, 'website' ), join( generationDir, 'backups', 'website' ) );
		mkdirSync( join( outputDir, 'website' ), { recursive: true } );
		writeFileSync( join( outputDir, 'website', 'index.html' ), 'partial-new' );
		const owner = {
			schema: EXPORT_PUBLICATION_LOCK_SCHEMA,
			pid: process.pid,
			startedAt: 'reused-pid-start',
			generation,
			token: randomUUID(),
		};
		writeFileSync( join( generationDir, 'owner.json' ), `${ JSON.stringify( owner ) }\n` );
		writeFileSync( join( generationDir, 'journal.jsonl' ), `${ JSON.stringify( {
			type: 'mutate-begin',
			path: 'website',
			action: 'replace',
			existed: true,
			backup: 'backups/website',
		} ) }\n` );
		writeFileSync( join( outputDir, '.export-publication.lock' ), `${ JSON.stringify( owner ) }\n` );
		const recovery = recoverExportPublication( outputDir );
		expect( recovery.outcome ).toBe( 'restored' );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toBe( 'previous' );
		expect( existsSync( join( outputDir, '.export-publication.lock' ) ) ).toBe( false );
	} );

	it( 'matches the owned manifest to names the exporter writes', () => {
		const outputDir = captureFixture(
			'<html><body><canvas id="stage"></canvas><main><div data-dla-geometry-id="wrapper-0"><section data-dla-geometry-id="target-0">Copy</section></div></main><script>const canvas=document.querySelector("canvas");canvas.getContext("2d");requestAnimationFrame(()=>{});</script></body></html>',
		);
		mkdirSync( join( outputDir, 'layout-geometry' ), { recursive: true } );
		const observation = {
			schema: 'data-liberation/layout-geometry-capture/v1',
			observations: [ {
				wrapperIdentity: 'wrapper-0',
				targetIdentity: 'target-0',
				viewport: 1440,
				state: 'default',
				wrapper: { x: 0, y: 0, width: 100, height: 24 },
				target: { x: 0, y: 0, width: 100, height: 24 },
				simulated: { x: 0, y: 0, width: 100, height: 24 },
				facts: { display: 'block', position: 'static', visibility: 'visible', childCount: 1 },
				invariants: { runtime: true, semantics: true },
			} ],
			omissions: {},
		};
		writeFileSync( join( outputDir, 'layout-geometry', 'homepage.desktop.json' ), JSON.stringify( observation ) );
		writeFileSync( join( outputDir, 'layout-geometry', 'homepage.mobile.json' ), JSON.stringify( {
			...observation,
			observations: [ { ...observation.observations[ 0 ], viewport: 390 } ],
		} ) );
		SectionSpecsStore.load( outputDir ).set( sourceUrl, [ {
			selector: 'main',
			headings: [ 'Copy' ],
			images: [],
			layout: {},
		} as never ], [] );
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) );
		manifest.entries[ sourceUrl ].interactions = { schema: INTERACTION_STATES_SCHEMA, states: [], initialDialogs: [] };
		manifest.entries[ sourceUrl ].scrollStates = {
			schema: SCROLL_STATES_SCHEMA,
			sourceUrl,
			viewport: { width: 1440, height: 900 },
			capturedAt: '2026-01-01T00:00:00.000Z',
			toggles: [ { thresholdPx: 1, classes: { add: [], remove: [] }, styleTargets: [] } ],
		};
		manifest.entries[ sourceUrl ].cleanup = {
			policy: cleanupPolicy(),
			reports: [ { failures: [], residual: 0 } ],
		};
		writeFileSync( join( outputDir, 'screenshots', 'manifest.json' ), JSON.stringify( manifest ) );
		const before = new Set( readdirSync( outputDir ) );
		exportWebsiteCapture( exportOptions( outputDir ) );
		const owned = new Set< string >( EXPORT_PUBLICATION_OWNED.map( ( item ) => item.path ) );
		for ( const name of readdirSync( outputDir ) ) {
			if ( before.has( name ) || name.startsWith( '.' ) ) continue;
			expect( owned.has( name ), name ).toBe( true );
		}
		for ( const item of EXPORT_PUBLICATION_OWNED ) {
			expect( existsSync( join( outputDir, item.path ) ), item.path ).toBe( true );
		}
		expect( existsSync( join( outputDir, '.export-publication.lock' ) ) ).toBe( false );
	} );

	it( 'preserves the primary error and journal when reading the journal fails', () => {
		const outputDir = captureFixture( '<main><h1>Original</h1></main>' );
		exportWebsiteCapture( exportOptions( outputDir ) );
		const before = snapshot( outputDir );
		writeFileSync( join( outputDir, 'html', 'homepage.html' ), '<main><h1>Partial</h1></main>' );
		armFault( EXPORT_PUBLICATION_BOUNDARIES.duringPublish );
		armFault( EXPORT_PUBLICATION_BOUNDARIES.readJournal );
		let caught: unknown;
		try {
			exportWebsiteCapture( exportOptions( outputDir ) );
		} catch ( error ) {
			caught = error;
		} finally {
			disarmFault( EXPORT_PUBLICATION_BOUNDARIES.duringPublish );
			disarmFault( EXPORT_PUBLICATION_BOUNDARIES.readJournal );
		}
		expect( caught ).toBeInstanceOf( FaultInjected );
		expect( ( caught as Error ).message ).toContain( EXPORT_PUBLICATION_BOUNDARIES.duringPublish );
		expect( ( caught as { exportPublicationRollbackFailure?: Error } ).exportPublicationRollbackFailure )
			.toBeInstanceOf( FaultInjected );
		const generation = readdirSync( join( outputDir, '.export-publication' ) )[ 0 ];
		const journal = readFileSync( join( outputDir, '.export-publication', generation!, 'journal.jsonl' ), 'utf8' );
		expect( journal ).toContain( '"type":"mutate-begin"' );
		expect( existsSync( join( outputDir, '.export-publication', generation!, 'backups', 'website' ) ) ).toBe( true );
		expect( recoverExportPublication( outputDir ).outcome ).toBe( 'restored' );
		expect( snapshot( outputDir ) ).toEqual( before );
	} );

	it( 'fails closed on a malformed journal and ignores only a torn trailing append', () => {
		const torn = tempDir();
		writeFileSync( join( torn, 'marker' ), 'untouched' );
		const tornGeneration = plantMixedWebsite( torn, ( generation ) =>
			`${ JSON.stringify( mutateBegin() ) }\n{"type":"committed","generation":"${ generation }"` );
		expect( recoverExportPublication( torn ).outcome ).toBe( 'restored' );
		expect( readFileSync( join( torn, 'website', 'index.html' ), 'utf8' ) ).toBe( 'previous' );
		expect( existsSync( join( torn, '.export-publication', tornGeneration ) ) ).toBe( false );
		expect( readFileSync( join( torn, 'marker' ), 'utf8' ) ).toBe( 'untouched' );

		const corrupt = tempDir();
		const corruptGeneration = plantMixedWebsite( corrupt, ( generation ) =>
			`${ JSON.stringify( mutateBegin() ) }\n{broken}\n${ JSON.stringify( { type: 'committed', generation } ) }\n` );
		const journalPath = join( corrupt, '.export-publication', corruptGeneration, 'journal.jsonl' );
		const journalBytes = readFileSync( journalPath );
		expect( () => recoverExportPublication( corrupt ) ).toThrow( ExportPublicationJournalError );
		expect( readFileSync( join( corrupt, 'website', 'index.html' ), 'utf8' ) ).toBe( 'partial-new' );
		expect( readFileSync( join( corrupt, '.export-publication', corruptGeneration, 'backups', 'website', 'index.html' ), 'utf8' ) ).toBe( 'previous' );
		expect( readFileSync( journalPath ) ).toEqual( journalBytes );
		expect( existsSync( join( corrupt, '.export-publication.lock' ) ) ).toBe( true );
	} );

	it( 'rejects a competing or stale recoverer without stealing the claim', () => {
		const outputDir = tempDir();
		mkdirSync( join( outputDir, 'website' ), { recursive: true } );
		writeFileSync( join( outputDir, 'website', 'index.html' ), 'public' );
		const recoverer = join( outputDir, '.export-publication.recoverer' );
		const startedAt = spawnSync( 'ps', [ '-o', 'lstart=', '-p', String( process.pid ) ], { encoding: 'utf8' } ).stdout.trim();
		const held = `${ JSON.stringify( {
			schema: EXPORT_PUBLICATION_LOCK_SCHEMA,
			pid: process.pid,
			startedAt,
			generation: 'recovery',
			token: 'parent-holds',
		} ) }\n`;
		writeFileSync( recoverer, held );
		const runner = join( outputDir, 'recover.ts' );
		writeFileSync( runner, `import { recoverExportPublication } from ${ JSON.stringify( new URL( './export-publication.ts', import.meta.url ).href ) };
recoverExportPublication( ${ JSON.stringify( outputDir ) } );
` );
		const child = spawnSync( process.execPath, [ '--import', 'tsx', runner ], {
			cwd: process.cwd(),
			encoding: 'utf8',
			timeout: 30_000,
		} );
		expect( child.status, child.stderr ).not.toBe( 0 );
		expect( child.stderr ).toContain( 'was not stolen' );
		expect( readFileSync( recoverer, 'utf8' ) ).toBe( held );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toBe( 'public' );
		writeFileSync( recoverer, `${ JSON.stringify( {
			schema: EXPORT_PUBLICATION_LOCK_SCHEMA,
			pid: 999999,
			startedAt: 'dead',
			generation: 'recovery',
			token: 'stale-recoverer',
		} ) }\n` );
		expect( () => recoverExportPublication( outputDir ) ).toThrow( /was not stolen/ );
		let built = false;
		expect( () => publishExportGeneration( outputDir, () => { built = true; } ) ).toThrow( /was not stolen/ );
		expect( built ).toBe( false );
		expect( readFileSync( recoverer, 'utf8' ) ).toContain( 'stale-recoverer' );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toBe( 'public' );
	} );
} );

function captureFixture( html: string ): string {
	const outputDir = tempDir();
	mkdirSync( join( outputDir, 'html' ), { recursive: true } );
	mkdirSync( join( outputDir, 'screenshots' ), { recursive: true } );
	mkdirSync( join( outputDir, 'resources' ), { recursive: true } );
	writeFileSync( join( outputDir, 'html', 'homepage.html' ), html );
	writeFileSync( join( outputDir, 'screenshots', 'manifest.json' ), JSON.stringify( {
		version: 1,
		entries: { [ sourceUrl ]: { slug: 'homepage', html: 'html/homepage.html' } },
	} ) );
	writeFileSync( join( outputDir, 'resources', 'kept.txt' ), 'capture-resource' );
	writeFileSync( join( outputDir, 'source-behavior.json' ), '{"unowned":true}\n' );
	return outputDir;
}

function httpFixture(): { outputDir: string } {
	const outputDir = tempDir();
	const html = '<main><h1>HTTP</h1></main>';
	mkdirSync( join( outputDir, 'source-documents' ), { recursive: true } );
	writeFileSync( join( outputDir, 'source-documents', 'home.html' ), html );
	writeFileSync( join( outputDir, 'http-acquisition.json' ), JSON.stringify( {
		schema: 'data-liberation/http-acquisition/v1',
		sourceUrl,
		documents: [ {
			url: sourceUrl,
			variant: 'desktop',
			status: 'acquired',
			documentPath: 'source-documents/home.html',
			documentContentType: 'text/html; charset=utf-8',
			documentSha256: createHash( 'sha256' ).update( html ).digest( 'hex' ),
			attempts: 1,
			durationMs: 1,
		} ],
	} ) );
	return { outputDir };
}

function exportOptions( outputDir: string ) {
	return { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] };
}

function tempDir(): string {
	mkdirSync( join( process.cwd(), '.tmp-test' ), { recursive: true } );
	const dir = mkdtempSync( join( process.cwd(), '.tmp-test', 'dla-export-publication-' ) );
	dirs.push( dir );
	return dir;
}

function writeGeneration( stageDir: string, marker: string ): void {
	mkdirSync( join( stageDir, 'website' ), { recursive: true } );
	writeFileSync( join( stageDir, 'website', 'index.html' ), marker );
	for ( const name of [
		'layout-geometry-report.json',
		'source-profile.json',
		'asset-evidence.json',
		'diagnostics.json',
		'capture-receipt.json',
	] ) {
		writeFileSync( join( stageDir, name ), `${ JSON.stringify( { generation: marker, name } ) }\n` );
	}
}

function expectFault( name: string, fn: () => void ): void {
	armFault( name );
	try {
		fn();
		throw new Error( `expected fault at ${ name }` );
	} catch ( error ) {
		if ( error instanceof Error && error.message === `expected fault at ${ name }` ) throw error;
		expect( error ).toBeInstanceOf( FaultInjected );
		expect( ( error as Error ).message ).toContain( name );
	} finally {
		disarmFault( name );
	}
}

function snapshot( outputDir: string ): Record< string, string | null > {
	const result: Record< string, string | null > = {};
	for ( const item of EXPORT_PUBLICATION_OWNED ) {
		const path = join( outputDir, item.path );
		result[ item.path ] = existsSync( path ) ? hashPath( path ) : null;
	}
	return result;
}

function hashPath( path: string ): string {
	const hash = createHash( 'sha256' );
	const walk = ( current: string ): void => {
		const stat = lstatSync( current );
		hash.update( stat.isDirectory() ? 'dir' : 'file' );
		if ( stat.isSymbolicLink() ) hash.update( 'symlink' );
		else if ( stat.isDirectory() ) {
			for ( const name of readdirSync( current ).sort() ) walk( join( current, name ) );
		} else hash.update( readFileSync( current ) );
	};
	walk( path );
	return hash.digest( 'hex' );
}

function assertNoStageIdentity( outputDir: string ): void {
	const files = [
		join( outputDir, 'capture-receipt.json' ),
		join( outputDir, 'diagnostics.json' ),
		join( outputDir, 'source-profile.json' ),
		join( outputDir, 'asset-evidence.json' ),
		join( outputDir, 'layout-geometry-report.json' ),
		join( outputDir, 'website', 'index.html' ),
	];
	for ( const path of files ) {
		expect( readFileSync( path, 'utf8' ) ).not.toContain( '.export-publication' );
	}
}

function writeRunner( outputDir: string, kind: 'export' | 'materialize' ): string {
	const runner = join( outputDir, 'run-export-publication.ts' );
	const specifier = kind === 'export'
		? new URL( './capture-export.ts', import.meta.url ).href
		: new URL( './http-materialization.ts', import.meta.url ).href;
	writeFileSync( runner, kind === 'export'
		? `import { exportWebsiteCapture } from ${ JSON.stringify( specifier ) };
exportWebsiteCapture( {
	outputDir: ${ JSON.stringify( outputDir ) },
	sourceUrl: ${ JSON.stringify( sourceUrl ) },
	platform: 'generic',
	title: 'replacement-generation',
	summary: {},
	failures: [],
} );
`
		: `import { materializeHttpDocuments } from ${ JSON.stringify( specifier ) };
materializeHttpDocuments( {
	outputDir: ${ JSON.stringify( outputDir ) },
	sourceUrl: ${ JSON.stringify( sourceUrl ) },
	platform: 'generic',
	desktopVariant: 'desktop',
} );
` );
	return runner;
}

function killExport( outputDir: string, seam: string ): void {
	writeFileSync( join( outputDir, 'html', 'homepage.html' ), '<main><h1>Replacement</h1></main>' );
	const runner = writeRunner( outputDir, 'export' );
	const result = spawnSync( process.execPath, [ '--import', 'tsx', runner ], {
		cwd: process.cwd(),
		env: { ...process.env, [ EXPORT_PUBLICATION_KILL ]: seam },
		encoding: 'utf8',
		timeout: 30_000,
	} );
	expect( result.signal, result.stderr ).toBe( 'SIGKILL' );
}

function spawnExport(
	outputDir: string,
	env: Record< string, string >,
	runner = writeRunner( outputDir, 'export' ),
): { done: Promise< void > } {
	const child = spawn( process.execPath, [ '--import', 'tsx', runner ], {
		cwd: process.cwd(),
		env: { ...process.env, ...env },
		stdio: [ 'ignore', 'pipe', 'pipe' ],
	} );
	let stderr = '';
	child.stderr?.on( 'data', ( chunk ) => { stderr += chunk; } );
	const done = new Promise< void >( ( resolve, reject ) => {
		const timer = setTimeout( () => {
			child.kill( 'SIGKILL' );
			reject( new Error( `export child timed out\n${ stderr }` ) );
		}, 20_000 );
		child.on( 'exit', ( code, signal ) => {
			clearTimeout( timer );
			if ( code === 0 ) resolve();
			else reject( new Error( `export child exited ${ code ?? signal }\n${ stderr }` ) );
		} );
	} );
	return { done };
}

function mutateBegin(): { type: 'mutate-begin'; path: 'website'; action: 'replace'; existed: true; backup: string } {
	return {
		type: 'mutate-begin',
		path: 'website',
		action: 'replace',
		existed: true,
		backup: join( 'backups', 'website' ),
	};
}

function plantMixedWebsite( outputDir: string, journal: ( generation: string ) => string ): string {
	mkdirSync( join( outputDir, 'website' ), { recursive: true } );
	writeFileSync( join( outputDir, 'website', 'index.html' ), 'previous' );
	const generation = randomUUID();
	const generationDir = join( outputDir, '.export-publication', generation );
	mkdirSync( join( generationDir, 'backups' ), { recursive: true } );
	renameSync( join( outputDir, 'website' ), join( generationDir, 'backups', 'website' ) );
	mkdirSync( join( outputDir, 'website' ), { recursive: true } );
	writeFileSync( join( outputDir, 'website', 'index.html' ), 'partial-new' );
	const owner = {
		schema: EXPORT_PUBLICATION_LOCK_SCHEMA,
		pid: 999999,
		startedAt: 'dead',
		generation,
		token: randomUUID(),
	};
	writeFileSync( join( generationDir, 'owner.json' ), `${ JSON.stringify( owner ) }\n` );
	writeFileSync( join( generationDir, 'journal.jsonl' ), journal( generation ) );
	writeFileSync( join( outputDir, '.export-publication.lock' ), `${ JSON.stringify( owner ) }\n` );
	return generation;
}

async function waitFor( predicate: () => boolean ): Promise< void > {
	const deadline = Date.now() + 10_000;
	const sleep = new Int32Array( new SharedArrayBuffer( 4 ) );
	while ( ! predicate() ) {
		if ( Date.now() > deadline ) throw new Error( 'timed out waiting for export publication' );
		Atomics.wait( sleep, 0, 0, 50 );
	}
}
