import { describe, expect, it } from 'vitest';
import { resolveInteractionComponents, shareInteractionComponents } from './captured-interactions.js';
import type { CapturedComponent } from './screenshot/component-states.js';

const component: CapturedComponent = { selector: '#menu', kind: 'menu', initial: 'closed', states: [], transitions: [], status: 'captured' };

describe('captured interaction references', () => {
	it('shares canonical cross-page duplicates without changing order or inline route-only components', () => {
		const unique = { ...component, selector: '#unique' };
		const reordered = Object.fromEntries(Object.entries(component).reverse()) as unknown as CapturedComponent;
		const pages = [
			{ sourceUrl: '/a', components: [component, unique, component] },
			{ sourceUrl: '/b', components: [reordered] },
		];
		const report = shareInteractionComponents(pages);
		expect(Object.keys(report.sharedComponents)).toHaveLength(1);
		expect(report.pages[0]!.components[1]).toEqual(unique);
		expect(resolveInteractionComponents(report).pages.map(page => page.components)).toEqual(pages.map(page => page.components));
		expect(Object.keys(shareInteractionComponents([...pages].reverse()).sharedComponents)).toEqual(Object.keys(report.sharedComponents));
	});

	it('does not share repeats within only one page', () => {
		expect(shareInteractionComponents([{ components: [component, component] }]).sharedComponents).toEqual({});
	});

	it('accepts v2 inline pages and diagnoses unresolved refs without dropping valid neighbors', () => {
		expect(resolveInteractionComponents({ pages: [{ components: [component] }] }).pages[0]!.components).toEqual([component]);
		const result = resolveInteractionComponents({ pages: [{ sourceUrl: '/a', components: [component, { ref: 'missing' }, { ref: '__proto__' }, component] }] });
		expect(result.pages[0]!.components).toEqual([component, component]);
		expect(result.diagnostics).toEqual([
			{ code: 'unresolved_component_ref', sourceUrl: '/a', componentIndex: 1, ref: 'missing' },
			{ code: 'unresolved_component_ref', sourceUrl: '/a', componentIndex: 2, ref: '__proto__' },
		]);
	});
});
