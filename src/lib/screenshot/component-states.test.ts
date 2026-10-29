import { expect, it } from 'vitest';
import { popupComponents, routeComponents } from './component-states.js';
import type { CapturedDialogInteraction, InteractionStatesReport } from './interaction-capture.js';
import { wireCapturedComponents } from '../static-components.js';
import { projectInitialDocument } from './initial-document.js';

it('records an unclassified surface as unsupported and never materializes it', () => {
	const state: CapturedDialogInteraction = {
		status: 'unsupported', trigger: { selector: '#open', tag: 'button', ariaHaspopup: '', dataBindings: {} },
		dialog: { selector: '#unknown', tag: 'div', ariaModal: false, html: '<div id="unknown">Unknown content</div>', htmlBytes: 45, htmlTruncated: false },
	};
	const nodes = popupComponents([state]);
	expect(nodes).toMatchObject([{ kind: 'unsupported', status: 'unsupported', initial: 'closed' }]);
	const initial = '<html><body><button id="open">Open</button></body></html>';
	expect(wireCapturedComponents(initial, nodes)).toBe(initial);
});

it('projects repeated popup evidence into one node without replacing its initial state', () => {
	const initial = { selector: '#open', kind: 'listbox' as const, initial: 'open', states: [{ id: 'open', html: '<div>Initial choice</div>' }], transitions: [], status: 'captured' as const };
	const evidence: CapturedDialogInteraction = { status: 'captured', trigger: { selector: '#open', tag: 'button', ariaHaspopup: '', dataBindings: {} }, dialog: { selector: '#options', tag: 'div', role: 'listbox', ariaModal: false, html: '<div>Explored choice</div>', htmlBytes: 26, htmlTruncated: false } };
	const report: InteractionStatesReport = { schema: 'blocks-engine-capture/interaction-states/v2', sourceUrl: 'https://example.com', viewport: { width: 1440, height: 900 }, capturedAt: '', states: [evidence, evidence], components: [initial] };
	const nodes = routeComponents(report);
	expect(nodes).toHaveLength(1);
	expect(nodes[0].initial).toBe('open');
	expect(nodes[0].states[0].html).toContain('Initial choice');
	expect(nodes[0].transitions).toHaveLength(1);
});

it('keeps initial content, selection and disclosure attributes when projecting learned geometry', () => {
	const initial = '<html><head></head><body><details open data-blocks-engine-capture-initial-node="0"><p>Initial answer</p></details></body></html>';
	const later = '<html><head></head><body><details data-blocks-engine-capture-initial-node="0" style="width:80vw"><p>Explored answer</p></details></body></html>';
	const projected = projectInitialDocument(initial, later);
	expect(projected).toContain('<details open="" style="width:80vw">');
	expect(projected).toContain('Initial answer');
	expect(projected).not.toContain('Explored answer');
	expect(projected).not.toContain('initial-node');
});
