import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { popupComponents, routeComponents } from './component-states.js';
import type { CapturedDialogInteraction, InteractionStatesReport } from './interaction-capture.js';
import { wireCapturedComponents } from '../static-components.js';
import { projectInitialDocument } from './initial-document.js';
import { WIDTH_CLASSES_ATTRIBUTE } from './viewport-class-states.js';

it('projects width-scoped class aliases in every materialized tab panel', () => {
	const alias = 'data-blocks-engine-capture-width-class-0123456789ab';
	const marker = JSON.stringify([['is-hidden', alias]]).replace(/"/g, '&quot;');
	const panel = (id: string) => `<div role="tabpanel" id="${id}"><div class="cell is-hidden" ${WIDTH_CLASSES_ATTRIBUTE}="${marker}">Cell</div></div>`;
	const page = `<html><body><div id="tabs" role="tablist"><button role="tab" aria-selected="true">All</button><button role="tab" aria-selected="false">Romance</button></div><div id="grid" role="tabpanel"><div class="cell ${alias}">Cell</div></div></body></html>`;
	const html = wireCapturedComponents(page, [{
		selector: '#tabs', kind: 'tabs', initial: 'tab-0', panel: '#grid', status: 'captured', transitions: [],
		states: [{ id: 'tab-0', html: panel('grid') }, { id: 'tab-1', html: panel('grid-tab-1') }],
	}]);
	const $ = cheerio.load(html);
	expect($('[role="tabpanel"]')).toHaveLength(2);
	expect($(`[role="tabpanel"] .cell.${alias}`)).toHaveLength(2);
	expect($('.is-hidden')).toHaveLength(0);
	expect(html).not.toContain(WIDTH_CLASSES_ATTRIBUTE);
});

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
