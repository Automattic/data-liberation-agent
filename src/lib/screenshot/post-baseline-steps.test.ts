import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import type { CapturedDialogInteraction, InteractionStatesReport } from './interaction-capture.js';

const menu: CapturedDialogInteraction = {
	status: 'captured',
	kind: 'dialog',
	trigger: { selector: 'header button', tag: 'button', ariaHaspopup: 'dialog', dataBindings: {} },
	reusedFrom: 'https://example.test/',
} as CapturedDialogInteraction;

// Preparing a route's own probes never returns, as on a renderer starved by host load.
vi.mock( './page-helpers.js', async original => ( {
	...await original<typeof import( './page-helpers.js' )>(),
	restoreTopScrollState: vi.fn( async () => {} ),
	dismissOverlays: vi.fn( () => new Promise( () => {} ) ),
} ) );
vi.mock( './probe-guards.js', () => ( { withReadOnlyProbes: ( _page: Page, run: () => Promise<unknown> ) => run() } ) );
vi.mock( './chrome-reuse.js', async original => ( {
	...await original<typeof import( './chrome-reuse.js' )>(),
	reuseSharedChrome: vi.fn( async () => ( { decision: { chromeReused: true, reason: 'matched' }, states: [ menu ], skip: '[data-reused]' } ) ),
} ) );

const { runSteps } = await import( './capture-steps.js' );
const { createPhaseBudget } = await import( './phase-budget.js' );
const { createPostBaselineState, postBaselineSteps, retainPartialPostBaseline } = await import( './post-baseline-steps.js' );

describe( 'post-baseline steps', () => {
	it( 'retain reused shared chrome when the route\'s own probes exhaust the budget', async () => {
		const page = { close: async () => {} } as unknown as Page;
		const promoted: InteractionStatesReport[] = [];
		const diagnostics: Array< { code: string } > = [];
		const context = {
			page, url: 'https://example.test/detail', navigationUrl: 'https://example.test/detail',
			viewport: { id: 'mobile', width: 402, height: 681 }, isDesktop: false,
			entry: {} as never, resourceStore: {} as never, componentBaseline: {} as never,
			sharedChrome: { status: 'captured', durationMs: 0, evidence: { url: 'https://example.test/', landmarks: [], states: [], unanchored: 0 } },
			diagnostics, scriptedLinkSignatures: [], routeRemainingMs: () => 1_000,
			state: createPostBaselineState(),
			promote: ( report: InteractionStatesReport ) => { promoted.push( report ); },
		} as unknown as Parameters< typeof retainPartialPostBaseline >[ 0 ];
		const budget = createPhaseBudget( page, 500, diagnostic => diagnostics.push( diagnostic ) );
		await runSteps( postBaselineSteps, context, { budget, rendererCrashed: () => false } );
		expect( budget.expired() ).toBe( true );
		retainPartialPostBaseline( context );
		expect( diagnostics.map( item => item.code ) ).toContain( 'interaction_phase_budget_exceeded' );
		expect( promoted ).toHaveLength( 1 );
		expect( promoted[ 0 ]!.coverage ).toBe( 'partial' );
		expect( promoted[ 0 ]!.states ).toContainEqual( menu );
	} );
} );
