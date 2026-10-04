import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { faultpoint } from './resume-state/faultpoint.js';

/**
 * Export-owned public names. Receipt is the commit marker and is published last.
 * Optional names absent from a generation are deleted; everything else in the
 * run directory is capture input or a later capture step and is not touched.
 */
export const EXPORT_PUBLICATION_OWNED = [
	{ path: 'website', kind: 'directory', required: true },
	{ path: 'layout-geometry-report.json', kind: 'file', required: true },
	{ path: 'source-profile.json', kind: 'file', required: true },
	{ path: 'asset-evidence.json', kind: 'file', required: true },
	{ path: 'diagnostics.json', kind: 'file', required: true },
	{ path: 'layout-geometry-proof.json', kind: 'file', required: false },
	{ path: 'source-interactivity.json', kind: 'file', required: false },
	{ path: 'semantic-evidence.index.json', kind: 'file', required: false },
	{ path: 'semantic-evidence', kind: 'directory', required: false },
	{ path: 'interaction-states.json', kind: 'file', required: false },
	{ path: 'scroll-states.json', kind: 'file', required: false },
	{ path: 'cleanup-evidence.json', kind: 'file', required: false },
	{ path: 'capture-receipt.json', kind: 'file', required: true, commit: true },
] as const;

export const EXPORT_PUBLICATION_LOCK_SCHEMA = 'data-liberation/export-publication-lock/v1';
export const EXPORT_PUBLICATION_SCRATCH = '.capture-export-html';
export const EXPORT_PUBLICATION_KILL = 'DLA_EXPORT_PUBLICATION_KILL';
export const EXPORT_PUBLICATION_HOLD = 'DLA_EXPORT_PUBLICATION_HOLD';

export const EXPORT_PUBLICATION_BOUNDARIES = {
	beforeStage: 'export-publication:before-stage',
	afterHtml: 'export-publication:after-html',
	sidecarWrite: 'export-publication:sidecar-write',
	journalPlan: 'export-publication:journal-plan',
	duringPublish: 'export-publication:during-publish',
	beforeReceipt: 'export-publication:before-receipt',
	receiptApplied: 'export-publication:journal-receipt-applied',
	afterReceipt: 'export-publication:after-receipt',
	rollback: 'export-publication:rollback',
	readJournal: 'export-publication:read-journal',
} as const;

type Owned = ( typeof EXPORT_PUBLICATION_OWNED )[ number ];
type OwnedKind = Owned[ 'kind' ];

interface LockFile {
	schema: typeof EXPORT_PUBLICATION_LOCK_SCHEMA;
	pid: number;
	startedAt: string | null;
	generation: string;
	token: string;
	rollbackFailed?: boolean;
}

interface PlannedOutput {
	path: string;
	kind: OwnedKind;
	action: 'replace' | 'delete';
	commit?: true;
}

interface MutateBegin {
	type: 'mutate-begin';
	path: string;
	action: 'replace' | 'delete';
	existed: boolean;
	backup: string | null;
}

type JournalRecord =
	| { type: 'plan'; generation: string; outputs: PlannedOutput[] }
	| MutateBegin
	| { type: 'backed-up'; path: string }
	| { type: 'applied'; path: string }
	| { type: 'committed'; generation: string };

export class ExportPublicationRejected extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'ExportPublicationRejected';
	}
}

export class ExportPublicationJournalError extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'ExportPublicationJournalError';
	}
}

export interface ExportPublicationRecovery {
	outcome: 'none' | 'restored' | 'finalized' | 'discarded';
	generation?: string;
}

export interface ExportPublication {
	readonly outputDir: string;
	readonly generation: string;
	readonly stageDir: string;
	publish(): void;
	abort( error: unknown ): void;
}

export function exportPublicationJournalBoundary(
	event: 'mutate-begin' | 'backed-up' | 'applied',
	path: string,
): string {
	return `export-publication:journal-${ event }:${ path }`;
}

export function exportPublicationBoundary( name: string ): void {
	faultpoint( name );
	if ( process.env[ EXPORT_PUBLICATION_KILL ] === name ) process.kill( process.pid, 'SIGKILL' );
}

export function recoverExportPublication( outputDir: string ): ExportPublicationRecovery {
	return recoverDeadPublication( resolve( outputDir ) );
}

export function beginExportPublication( outputDir: string ): ExportPublication {
	exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.beforeStage );
	const root = resolve( outputDir );
	recoverDeadPublication( root );
	rejectIfRecoverer( root );
	const live = liveGeneration( root );
	if ( live ) throw rejected( live.pid );
	const generation = randomUUID();
	const generationDir = join( root, '.export-publication', generation );
	const stageDir = join( generationDir, 'stage' );
	mkdirSync( stageDir, { recursive: true } );
	const owner: LockFile = {
		schema: EXPORT_PUBLICATION_LOCK_SCHEMA,
		pid: process.pid,
		startedAt: processStart( process.pid ),
		generation,
		token: randomUUID(),
	};
	writeFileSync( join( generationDir, 'owner.json' ), `${ JSON.stringify( owner ) }\n` );
	const session = new PublicationSession( root, owner, generationDir, stageDir );
	try {
		writeFileSync( lockPath( root ), `${ JSON.stringify( owner ) }\n`, { flag: 'wx' } );
	} catch ( error ) {
		rmSync( generationDir, { recursive: true, force: true } );
		if ( isEexist( error ) ) {
			const holder = readLock( lockPath( root ) );
			throw rejected( holder?.pid );
		}
		throw error;
	}
	if ( existsSync( recovererPath( root ) ) ) {
		session.abort( new Error( 'Export publication recovery is in progress' ) );
		throw recoveryBlocked();
	}
	try {
		holdForTest();
	} catch ( error ) {
		session.abort( error );
		throw error;
	}
	return session;
}

export function publishExportGeneration(
	outputDir: string,
	build: ( stageDir: string ) => void,
): string {
	const publication = beginExportPublication( outputDir );
	try {
		build( publication.stageDir );
		publication.publish();
	} catch ( error ) {
		publication.abort( error );
		throw error;
	}
	return join( resolve( outputDir ), 'capture-receipt.json' );
}

class PublicationSession implements ExportPublication {
	private closed = false;

	constructor(
		readonly outputDir: string,
		private readonly owner: LockFile,
		private readonly generationDir: string,
		readonly stageDir: string,
	) {}

	get generation(): string {
		return this.owner.generation;
	}

	publish(): void {
		try {
			this.publishInner();
		} catch ( error ) {
			this.abort( error );
			throw error;
		}
	}

	abort( error: unknown ): void {
		if ( this.closed ) return;
		this.closed = true;
		try {
			const records = readJournal( this.journalPath(), this.generation );
			if ( records.some( ( record ) => record.type === 'committed' ) ) {
				this.removePrivate();
				return;
			}
			if ( records.some( ( record ) => record.type === 'mutate-begin' ) ) {
				exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.rollback );
				rollbackGeneration( this.outputDir, this.generationDir, records );
			}
			this.removePrivate();
		} catch ( rollbackError ) {
			attachRollbackFailure( error, rollbackError );
			this.markRecoverable();
		}
	}

	private publishInner(): void {
		if ( existsSync( recovererPath( this.outputDir ) ) ) throw recoveryBlocked();
		const planned = this.preflight();
		if ( statSync( this.outputDir ).dev !== statSync( this.stageDir ).dev ) {
			throw new Error( 'Export publication staging must stay on the output filesystem' );
		}
		appendJournal( this.journalPath(), {
			type: 'plan',
			generation: this.generation,
			outputs: planned,
		} );
		exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.journalPlan );
		const rest = planned.filter( ( item ) => ! item.commit );
		for ( const item of rest ) {
			this.mutate( item );
			if ( item.path === 'website' ) {
				exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.duringPublish );
			}
		}
		exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.beforeReceipt );
		const receipt = planned.find( ( item ) => item.commit );
		if ( ! receipt ) throw new Error( 'Export publication is missing capture-receipt.json' );
		this.mutate( receipt );
		exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.receiptApplied );
		appendJournal( this.journalPath(), { type: 'committed', generation: this.generation } );
		exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.afterReceipt );
		this.removePrivate();
	}

	private preflight(): PlannedOutput[] {
		const present = new Set(
			readdirSync( this.stageDir ).filter( ( name ) => name !== EXPORT_PUBLICATION_SCRATCH ),
		);
		for ( const name of present ) {
			if ( ! EXPORT_PUBLICATION_OWNED.some( ( item ) => item.path === name ) ) {
				throw new Error( `Export publication stage contains an unowned name: ${ name }` );
			}
		}
		const planned: PlannedOutput[] = [];
		for ( const item of EXPORT_PUBLICATION_OWNED ) {
			const stagePath = join( this.stageDir, item.path );
			const publicPath = join( this.outputDir, item.path );
			assertWithin( this.stageDir, stagePath );
			assertWithin( this.outputDir, publicPath );
			const staged = describe( stagePath );
			const published = describe( publicPath );
			if ( staged.symlink || published.symlink ) {
				throw new Error( `Export publication refuses a symlink at ${ item.path }` );
			}
			if ( item.required && ! staged.exists ) {
				throw new Error( `Export publication stage is missing owned output: ${ item.path }` );
			}
			if ( staged.exists && staged.directory !== ( item.kind === 'directory' ) ) {
				throw new Error( `Export publication owned output has the wrong kind: ${ item.path }` );
			}
			if ( staged.exists ) {
				planned.push( {
					path: item.path,
					kind: item.kind,
					action: 'replace',
					...( 'commit' in item && item.commit ? { commit: true } : {} ),
				} );
			} else {
				planned.push( { path: item.path, kind: item.kind, action: 'delete' } );
			}
		}
		return planned;
	}

	private mutate( item: PlannedOutput ): void {
		if ( existsSync( recovererPath( this.outputDir ) ) ) throw recoveryBlocked();
		const publicPath = join( this.outputDir, item.path );
		const published = describe( publicPath );
		if ( published.symlink ) throw new Error( `Export publication refuses a symlink at ${ item.path }` );
		const backup = published.exists ? join( 'backups', item.path ) : null;
		const begin: MutateBegin = {
			type: 'mutate-begin',
			path: item.path,
			action: item.action,
			existed: published.exists,
			backup,
		};
		appendJournal( this.journalPath(), begin );
		exportPublicationBoundary( exportPublicationJournalBoundary( 'mutate-begin', item.path ) );
		if ( published.exists && backup ) {
			const backupPath = join( this.generationDir, backup );
			mkdirSync( join( this.generationDir, 'backups' ), { recursive: true } );
			renameSync( publicPath, backupPath );
			appendJournal( this.journalPath(), { type: 'backed-up', path: item.path } );
			exportPublicationBoundary( exportPublicationJournalBoundary( 'backed-up', item.path ) );
		}
		if ( item.action === 'replace' ) {
			renameSync( join( this.stageDir, item.path ), publicPath );
		}
		appendJournal( this.journalPath(), { type: 'applied', path: item.path } );
		exportPublicationBoundary( exportPublicationJournalBoundary( 'applied', item.path ) );
	}

	private journalPath(): string {
		return join( this.generationDir, 'journal.jsonl' );
	}

	private markRecoverable(): void {
		const marked: LockFile = { ...this.owner, pid: 0, startedAt: null, rollbackFailed: true };
		try {
			writeFileSync( lockPath( this.outputDir ), `${ JSON.stringify( marked ) }\n` );
		} catch {
			// The original lock still names this process until it exits.
		}
	}

	private removePrivate(): void {
		rmSync( this.generationDir, { recursive: true, force: true } );
		releaseLock( this.outputDir, this.generation );
		const root = join( this.outputDir, '.export-publication' );
		if ( existsSync( root ) && readdirSync( root ).length === 0 ) rmSync( root, { recursive: true, force: true } );
	}
}

function recoverDeadPublication( outputDir: string ): ExportPublicationRecovery {
	const lock = readLock( lockPath( outputDir ) );
	if ( lock && ownerAlive( lock ) ) throw rejected( lock.pid );
	rejectIfRecoverer( outputDir );
	const dead = deadGenerations( outputDir );
	if ( ! lock && dead.length === 0 && ! existsSync( lockPath( outputDir ) ) ) return { outcome: 'none' };
	const claim = claimRecoverer( outputDir );
	try {
		const current = readLock( lockPath( outputDir ) );
		if ( current && ownerAlive( current ) ) throw rejected( current.pid );
		let outcome: ExportPublicationRecovery[ 'outcome' ] = 'none';
		let generation: string | undefined;
		if ( current && ! ownerAlive( current ) ) {
			outcome = recoverGeneration( outputDir, current.generation );
			generation = current.generation;
			releaseLock( outputDir, current.generation );
		} else if ( existsSync( lockPath( outputDir ) ) && ! current ) {
			throw new ExportPublicationRejected(
				'Export publication lock is corrupt and was not stolen. Concurrent export is rejected and is not rematerialized.',
			);
		}
		for ( const candidate of deadGenerations( outputDir ) ) {
			if ( ownerAlive( candidate ) ) continue;
			const next = recoverGeneration( outputDir, candidate.generation );
			if ( outcome === 'none' || next === 'restored' ) {
				outcome = next;
				generation = candidate.generation;
			}
		}
		return { outcome, ...( generation ? { generation } : {} ) };
	} finally {
		releaseRecoverer( outputDir, claim.token );
	}
}

function recoverGeneration( outputDir: string, generation: string ): ExportPublicationRecovery[ 'outcome' ] {
	if ( ! isGenerationId( generation ) ) {
		throw new Error( 'Export publication recovery refused an invalid generation id' );
	}
	const generationDir = join( outputDir, '.export-publication', generation );
	if ( ! existsSync( generationDir ) ) return 'discarded';
	const records = readJournal( join( generationDir, 'journal.jsonl' ), generation );
	if ( records.length === 0 && existsSync( join( generationDir, 'backups' ) ) ) {
		throw new ExportPublicationJournalError( 'Export publication backups exist without a readable journal' );
	}
	if ( records.some( ( record ) => record.type === 'committed' ) ) {
		rmSync( generationDir, { recursive: true, force: true } );
		return 'finalized';
	}
	if ( records.some( ( record ) => record.type === 'mutate-begin' ) ) {
		rollbackGeneration( outputDir, generationDir, records );
		rmSync( generationDir, { recursive: true, force: true } );
		return 'restored';
	}
	rmSync( generationDir, { recursive: true, force: true } );
	return 'discarded';
}

function rollbackGeneration( outputDir: string, generationDir: string, records: JournalRecord[] ): void {
	if ( records.some( ( record ) => record.type === 'committed' ) ) return;
	const begins = records.filter( ( record ): record is MutateBegin => record.type === 'mutate-begin' );
	for ( const begin of begins.reverse() ) {
		if ( ! EXPORT_PUBLICATION_OWNED.some( ( item ) => item.path === begin.path ) ) {
			throw new Error( `Export publication rollback refused an unowned path: ${ begin.path }` );
		}
		const publicPath = join( outputDir, begin.path );
		assertWithin( outputDir, publicPath );
		const published = describe( publicPath );
		const backupPath = begin.backup ? join( generationDir, begin.backup ) : null;
		if ( backupPath ) assertWithin( generationDir, backupPath );
		const backup = backupPath ? describe( backupPath ) : { exists: false, symlink: false, directory: false };
		if ( published.symlink || backup.symlink ) {
			throw new Error( `Export publication rollback refused a symlink at ${ begin.path }` );
		}
		if ( begin.existed ) {
			if ( ! backup.exists ) {
				if ( ! published.exists ) throw new Error( `Export publication rollback cannot restore ${ begin.path }` );
				continue;
			}
			if ( published.exists ) rmSync( publicPath, { recursive: true, force: true } );
			renameSync( backupPath!, publicPath );
		} else if ( published.exists ) {
			rmSync( publicPath, { recursive: true, force: true } );
		}
	}
}

function claimRecoverer( outputDir: string ): LockFile {
	const path = recovererPath( outputDir );
	if ( existsSync( path ) ) throw recoveryBlocked();
	const claim: LockFile = {
		schema: EXPORT_PUBLICATION_LOCK_SCHEMA,
		pid: process.pid,
		startedAt: processStart( process.pid ),
		generation: 'recovery',
		token: randomUUID(),
	};
	try {
		writeFileSync( path, `${ JSON.stringify( claim ) }\n`, { flag: 'wx' } );
	} catch ( error ) {
		if ( isEexist( error ) ) throw recoveryBlocked();
		throw error;
	}
	return claim;
}

function rejectIfRecoverer( outputDir: string ): void {
	if ( existsSync( recovererPath( outputDir ) ) ) throw recoveryBlocked();
}

function recoveryBlocked(): ExportPublicationRejected {
	return new ExportPublicationRejected(
		'Export publication recoverer is present and was not stolen. Concurrent export is rejected and is not rematerialized. Remove .export-publication.recoverer only after confirming no recovery is in progress.',
	);
}

function releaseRecoverer( outputDir: string, token: string ): void {
	const path = recovererPath( outputDir );
	const current = readLock( path );
	if ( current?.token === token ) {
		try {
			unlinkSync( path );
		} catch {
			// Already gone.
		}
	}
}

function releaseLock( outputDir: string, generation: string ): void {
	const path = lockPath( outputDir );
	const current = readLock( path );
	if ( current?.generation === generation ) {
		try {
			unlinkSync( path );
		} catch {
			// Already gone.
		}
	}
}

function liveGeneration( outputDir: string ): LockFile | null {
	const lock = readLock( lockPath( outputDir ) );
	if ( lock && ownerAlive( lock ) ) return lock;
	return deadGenerations( outputDir ).find( ( owner ) => ownerAlive( owner ) ) ?? null;
}

function deadGenerations( outputDir: string ): LockFile[] {
	const root = join( outputDir, '.export-publication' );
	if ( ! existsSync( root ) ) return [];
	const owners: LockFile[] = [];
	for ( const name of readdirSync( root ) ) {
		if ( ! isGenerationId( name ) ) continue;
		const owner = readLock( join( root, name, 'owner.json' ) );
		if ( owner ) owners.push( owner );
	}
	return owners;
}

function ownerAlive( lock: LockFile ): boolean {
	if ( lock.rollbackFailed || ! Number.isInteger( lock.pid ) || lock.pid <= 0 ) return false;
	if ( ! pidExists( lock.pid ) ) return false;
	if ( ! lock.startedAt ) return true;
	const current = processStart( lock.pid );
	if ( ! current ) return true;
	return current === lock.startedAt;
}

function pidExists( pid: number ): boolean {
	if ( ! Number.isInteger( pid ) || pid <= 0 ) return false;
	try {
		process.kill( pid, 0 );
		return true;
	} catch ( error ) {
		return ! isEsrch( error );
	}
}

function processStart( pid: number ): string | null {
	if ( ! Number.isInteger( pid ) || pid <= 0 ) return null;
	const result = spawnSync( 'ps', [ '-o', 'lstart=', '-p', String( pid ) ], {
		encoding: 'utf8',
		timeout: 2_000,
	} );
	if ( result.status !== 0 ) return null;
	const text = result.stdout.trim();
	return text || null;
}

function rejected( pid?: number ): ExportPublicationRejected {
	const who = pid && pid > 0 ? `pid ${ pid }` : 'another export';
	return new ExportPublicationRejected(
		`Export publication rejected: ${ who } already holds the single-writer lock. Concurrent export is rejected and is not rematerialized.`,
	);
}

function readJournal( path: string, generation: string ): JournalRecord[] {
	exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.readJournal );
	if ( ! existsSync( path ) ) return [];
	const text = readFileSync( path, 'utf8' );
	const lines = text.split( '\n' );
	if ( ! text.endsWith( '\n' ) ) {
		const tail = lines.pop() ?? '';
		if ( tail.trim() && ! parsesJson( tail ) ) {
			// A kill can tear the in-progress append. A newline-terminated line is complete.
		} else if ( tail.trim() ) lines.push( tail );
	}
	const records: JournalRecord[] = [];
	for ( const line of lines ) {
		if ( ! line.trim() ) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse( line );
		} catch {
			throw new ExportPublicationJournalError( 'Export publication journal has a malformed record' );
		}
		records.push( validateJournalRecord( parsed, generation ) );
	}
	return records;
}

function parsesJson( value: string ): boolean {
	try {
		JSON.parse( value );
		return true;
	} catch {
		return false;
	}
}

function validateJournalRecord( value: unknown, generation: string ): JournalRecord {
	if ( ! value || typeof value !== 'object' ) throw journalError( 'record' );
	const record = value as Record< string, unknown >;
	if ( record.type === 'plan' ) {
		if ( record.generation !== generation || ! Array.isArray( record.outputs ) ) throw journalError( 'plan' );
		return {
			type: 'plan',
			generation,
			outputs: record.outputs.map( ( output ) => validatePlanned( output ) ),
		};
	}
	if ( record.type === 'mutate-begin' ) {
		const path = ownedJournalPath( record.path );
		if ( ( record.action !== 'replace' && record.action !== 'delete' ) || typeof record.existed !== 'boolean' ) {
			throw journalError( 'mutate-begin' );
		}
		if ( record.backup !== null && record.backup !== join( 'backups', path ) ) throw journalError( 'backup' );
		return {
			type: 'mutate-begin',
			path,
			action: record.action,
			existed: record.existed,
			backup: record.backup,
		};
	}
	if ( record.type === 'backed-up' || record.type === 'applied' ) {
		return { type: record.type, path: ownedJournalPath( record.path ) };
	}
	if ( record.type === 'committed' ) {
		if ( record.generation !== generation ) throw journalError( 'committed generation' );
		return { type: 'committed', generation };
	}
	throw journalError( 'type' );
}

function validatePlanned( value: unknown ): PlannedOutput {
	if ( ! value || typeof value !== 'object' ) throw journalError( 'plan output' );
	const output = value as Record< string, unknown >;
	const path = ownedJournalPath( output.path );
	const owned = EXPORT_PUBLICATION_OWNED.find( ( item ) => item.path === path );
	if ( ! owned || output.kind !== owned.kind || ( output.action !== 'replace' && output.action !== 'delete' ) ) {
		throw journalError( 'plan output' );
	}
	if ( output.commit !== undefined && output.commit !== true ) throw journalError( 'plan commit' );
	return {
		path,
		kind: owned.kind,
		action: output.action,
		...( output.commit === true ? { commit: true } : {} ),
	};
}

function ownedJournalPath( value: unknown ): string {
	if ( typeof value !== 'string' || value.includes( '\n' ) || ! EXPORT_PUBLICATION_OWNED.some( ( item ) => item.path === value ) ) {
		throw journalError( 'path' );
	}
	return value;
}

function journalError( field: string ): ExportPublicationJournalError {
	return new ExportPublicationJournalError( `Export publication journal failed closed at ${ field }` );
}

function appendJournal( path: string, record: JournalRecord ): void {
	mkdirSync( join( path, '..' ), { recursive: true } );
	appendFileSync( path, `${ JSON.stringify( record ) }\n` );
}

function readLock( path: string ): LockFile | null {
	if ( ! existsSync( path ) ) return null;
	try {
		const parsed = JSON.parse( readFileSync( path, 'utf8' ) ) as Partial< LockFile >;
		if (
			parsed.schema !== EXPORT_PUBLICATION_LOCK_SCHEMA ||
			typeof parsed.generation !== 'string' ||
			typeof parsed.token !== 'string' ||
			typeof parsed.pid !== 'number'
		) return null;
		return {
			schema: EXPORT_PUBLICATION_LOCK_SCHEMA,
			pid: parsed.pid,
			startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
			generation: parsed.generation,
			token: parsed.token,
			...( parsed.rollbackFailed === true ? { rollbackFailed: true } : {} ),
		};
	} catch {
		return null;
	}
}

function describe( path: string ): { exists: boolean; symlink: boolean; directory: boolean } {
	try {
		const stat = lstatSync( path );
		return { exists: true, symlink: stat.isSymbolicLink(), directory: stat.isDirectory() };
	} catch ( error ) {
		if ( isEnoent( error ) ) return { exists: false, symlink: false, directory: false };
		throw error;
	}
}

function assertWithin( root: string, candidate: string ): void {
	const rel = relative( resolve( root ), resolve( candidate ) );
	if ( rel === '' || rel === '..' || rel.startsWith( `..${ sep }` ) || isAbsolute( rel ) ) {
		throw new Error( 'Export publication path escapes its root' );
	}
}

function isGenerationId( value: string ): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test( value );
}

function lockPath( outputDir: string ): string {
	return join( outputDir, '.export-publication.lock' );
}

function recovererPath( outputDir: string ): string {
	return join( outputDir, '.export-publication.recoverer' );
}

function attachRollbackFailure( primary: unknown, rollbackError: unknown ): void {
	if ( primary instanceof Error ) {
		Object.defineProperty( primary, 'exportPublicationRollbackFailure', {
			value: rollbackError,
			enumerable: false,
			configurable: true,
		} );
	}
}

function isEexist( error: unknown ): boolean {
	return codeOf( error ) === 'EEXIST';
}

function isEnoent( error: unknown ): boolean {
	return codeOf( error ) === 'ENOENT';
}

function isEsrch( error: unknown ): boolean {
	return codeOf( error ) === 'ESRCH';
}

function codeOf( error: unknown ): string | undefined {
	return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
		? error.code
		: undefined;
}

function holdForTest(): void {
	const hold = process.env[ EXPORT_PUBLICATION_HOLD ];
	if ( ! hold ) return;
	const deadline = Date.now() + Number( process.env.DLA_EXPORT_PUBLICATION_HOLD_MS ?? 20_000 );
	const sleep = new Int32Array( new SharedArrayBuffer( 4 ) );
	while ( existsSync( hold ) ) {
		if ( Date.now() > deadline ) throw new Error( 'Export publication hold timed out' );
		Atomics.wait( sleep, 0, 0, 50 );
	}
}
