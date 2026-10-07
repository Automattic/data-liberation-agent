import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { preserveWixCollections, wixCollectionsFromHtml } from './collections.js';

// Shape observed in publicly served Wix CMS warmup data; values are neutral fixture data.
function fixture(options: { total?: number; loaded?: number; itemIds?: string[]; route?: string; status?: string; title?: string; duplicate?: boolean } = {}): string {
	const schema = {
		id: 'Agencies', displayName: 'Agencies', displayField: 'title',
		fields: {
			title: { type: 'text', displayName: 'Title' },
			image: { type: 'image', displayName: 'Image' },
			unit: { type: 'multi-reference', referencedCollection: 'Units' },
			'_owner': { type: 'text', systemField: true },
			'link-agencies-title': { type: 'pagelink', systemField: true, calculator: { config: { pattern: '/agency/{title}' } } },
		},
	};
	const row = { _id: 'a', _owner: 'publisher-identity', _publishStatus: options.status ?? 'PUBLISHED', title: options.title ?? 'First agency', image: 'wix:image://v1/asset.png', 'link-agencies-title': options.route ?? '/agency/first' };
	const warmup = { appsWarmupData: { dataBinding: {
		schemas: { Agencies: schema, Units: { id: 'Units', displayName: 'Units', fields: { title: { type: 'text' } } } },
		dataStore: {
			recordsByCollectionId: { Agencies: { a: row }, ...(options.duplicate ? { Units: { a: { _id: 'a', title: 'Ambiguous ID' } } } : {}) },
			recordInfosByDatasetId: { listing: { itemIds: options.itemIds ?? ['a'], datasetSize: { total: options.total ?? 1, loaded: options.loaded ?? 1 } } },
		},
	} } };
	return `<html><head><script type="application/json" id="wix-essential-viewer-model">${JSON.stringify({ requestUrl: 'https://fixture.test/agencies' })}</script><script type="application/json" id="wix-warmup-data">${JSON.stringify(warmup).replace(/</g, '\\u003c')}</script></head><body><h1>Agencies</h1></body></html>`;
}

describe('Wix source collections', () => {
	it('retains typed schemas, actual record identities, source routes and dataset-scoped counts', () => {
		const evidence = wixCollectionsFromHtml(fixture())!;
		const agencies = evidence.collections.find(collection => collection.id === 'Agencies')!;
		expect(evidence.schema).toBe('source/collections/v1');
		expect(agencies.fields.find(field => field.id === 'unit')).toMatchObject({ source_type: 'multi-reference', reference_collection: 'Units' });
		expect(agencies.records[0]).toMatchObject({ id: 'a', source_routes: ['/agency/first'], values: { title: 'First agency' } });
		expect(agencies.coverage).toEqual({ observed_records: 1, retained_records: 1, dataset_complete: true, scope: 'observed_datasets' });
		expect(JSON.stringify(evidence)).not.toContain('publisher-identity');
		expect(agencies.fields.some(field => field.id === '_owner')).toBe(false);
		expect(evidence.diagnostics).toContainEqual({ code: 'collection_relationship_inventory_unobserved', collection_id: 'Agencies', field_id: 'unit' });
		expect(evidence.diagnostics).toContainEqual({ code: 'collection_relationship_value_unobserved', collection_id: 'Agencies', record_id: 'a', field_id: 'unit' });
	});

	it.each([
		{ total: 2, loaded: 1 },
		{ itemIds: ['a', 'a'], loaded: 2, total: 2 },
		{ duplicate: true },
		{ status: 'DRAFT' },
	])('does not substitute record counts for incomplete or ambiguous dataset proof: %j', options => {
		const agencies = wixCollectionsFromHtml(fixture(options))!.collections.find(collection => collection.id === 'Agencies')!;
		expect(agencies.coverage.dataset_complete).toBe(false);
	});

	it('rejects cross-origin detail ownership while retaining the observed field value', () => {
		const evidence = wixCollectionsFromHtml(fixture({ route: 'https://other.test/agency/first' }))!;
		expect(evidence.collections[0].records[0].source_routes).toEqual([]);
		expect(evidence.collections[0].records[0].values['link-agencies-title']).toBe('https://other.test/agency/first');
		expect(evidence.diagnostics.some(diagnostic => diagnostic.code === 'collection_record_route_unproven')).toBe(true);
	});

	it('keeps metadata inert, preserves ordinary content and emits one evidence script on repeated projection', () => {
		const html = fixture({ title: '</script><script>globalThis.executed=true</script>' });
		const projected = preserveWixCollections(preserveWixCollections(html));
		const $ = cheerio.load(projected);
		expect($('body').text()).toBe('Agencies');
		expect($('script[data-dla-source-evidence="collections"]')).toHaveLength(1);
		expect($('script').filter((_, script) => !$(script).attr('type'))).toHaveLength(0);
		expect(JSON.parse($('script[data-dla-source-evidence="collections"]').text()).collections[0].records[0].values.title).toBe('</script><script>globalThis.executed=true</script>');
	});

	it('leaves non-CMS capture unchanged and never manufactures collections from rendered cards', () => {
		const html = '<html><body><h1>Agencies</h1><article>First agency</article></body></html>';
		expect(wixCollectionsFromHtml(html)).toBeNull();
		expect(preserveWixCollections(html)).toBe(html);
	});
});
