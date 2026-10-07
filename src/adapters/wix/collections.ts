import * as cheerio from 'cheerio';

export const SOURCE_COLLECTIONS_SCHEMA = 'source/collections/v1';
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_COLLECTIONS = 20;
const MAX_FIELDS = 64;
const MAX_RECORDS = 200;
const MAX_EVIDENCE_BYTES = 256_000;

type ObjectValue = Record<string, unknown>;
interface Diagnostic { code: string; collection_id?: string; record_id?: string; field_id?: string; }
export interface SourceCollectionField {
	id: string;
	label: string;
	source_type: string;
	system: boolean;
	reference_collection?: string;
	route_pattern?: string;
}
export interface SourceCollection {
	id: string;
	label: string;
	display_field: string;
	fields: SourceCollectionField[];
	records: Array<{ id: string; values: ObjectValue; source_routes: string[] }>;
	datasets: Array<{ id: string; total: number | null; loaded: number | null; record_ids: string[] }>;
	coverage: { observed_records: number; retained_records: number; dataset_complete: boolean; scope: 'observed_datasets' };
}
export interface SourceCollections {
	schema: typeof SOURCE_COLLECTIONS_SCHEMA;
	source_url: string;
	collections: SourceCollection[];
	diagnostics: Diagnostic[];
}

function object(value: unknown): ObjectValue {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
}
function text(value: unknown, limit = 256): string {
	return typeof value === 'string' && value.length <= limit ? value : '';
}
function count(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
function sourceJson($: cheerio.CheerioAPI, id: string): ObjectValue {
	const nodes = $(`script[id="${id}"][type="application/json"]`);
	if (nodes.length !== 1) return {};
	const source = nodes.text();
	if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return {};
	try { return object(JSON.parse(source)); } catch { return {}; }
}

/** Clone bounded JSON values into plain data; schema metadata never becomes code. */
function value(source: unknown, depth = 0): unknown {
	if (depth > 8) throw new Error('Source value depth exceeded');
	if (source === null || typeof source === 'boolean') return source;
	if (typeof source === 'number' && Number.isFinite(source)) return source;
	if (typeof source === 'string' && source.length <= 8192) return source;
	if (Array.isArray(source) && source.length <= MAX_RECORDS) return source.map(item => value(item, depth + 1));
	const entries = Object.entries(object(source));
	if (source !== undefined && typeof source === 'object' && entries.length <= MAX_FIELDS) {
		return Object.fromEntries(entries.map(([key, item]) => [key, value(item, depth + 1)]));
	}
	throw new Error('Source value bound exceeded');
}

function sourceRoute(raw: unknown, sourceUrl: string): string | null {
	if (typeof raw !== 'string' || raw.length > 2048) return null;
	try {
		const route = new URL(raw, sourceUrl);
		if (route.origin !== new URL(sourceUrl).origin || route.search || route.hash) return null;
		return route.pathname;
	} catch { return null; }
}

/** Wix recognition stays here; the output is destination-neutral source evidence. */
export function wixCollectionsFromHtml(html: string): SourceCollections | null {
	const $ = cheerio.load(html);
	const essential = sourceJson($, 'wix-essential-viewer-model');
	const viewer = sourceJson($, 'wix-viewer-model');
	const warmup = sourceJson($, 'wix-warmup-data');
	const binding = object(object(warmup.appsWarmupData).dataBinding);
	const schemas = object(binding.schemas);
	if (Object.keys(schemas).length === 0) return null;
	const sourceUrl = text(viewer.requestUrl || essential.requestUrl, 2048);
	try { if (!['http:', 'https:'].includes(new URL(sourceUrl).protocol)) return null; } catch { return null; }
	const data = object(binding.dataStore);
	const recordsByCollection = object(data.recordsByCollectionId);
	const diagnostics: Diagnostic[] = [];
	const collections: SourceCollection[] = [];
	const entries = Object.entries(schemas).sort(([left], [right]) => left.localeCompare(right));
	if (entries.length > MAX_COLLECTIONS) diagnostics.push({ code: 'collection_inventory_truncated' });
	for (const [id, rawSchema] of entries.slice(0, MAX_COLLECTIONS)) {
		const schema = object(rawSchema);
		if (!text(id) || schema.isDeleted === true || schema.id !== id) {
			diagnostics.push({ code: 'collection_schema_invalid', collection_id: id });
			continue;
		}
		const fieldEntries = Object.entries(object(schema.fields));
		if (fieldEntries.length > MAX_FIELDS) diagnostics.push({ code: 'collection_fields_truncated', collection_id: id });
		const fields: SourceCollectionField[] = [];
		for (const [fieldId, rawField] of fieldEntries.slice(0, MAX_FIELDS)) {
			const field = object(rawField);
			// Publisher identity is not collection content. Other system fields remain typed evidence.
			if (fieldId === '_owner' || field.isDeleted === true) continue;
			if (!text(fieldId) || !text(field.type)) {
				diagnostics.push({ code: 'collection_field_invalid', collection_id: id, field_id: fieldId });
				continue;
			}
			const projected: SourceCollectionField = {
				id: fieldId, label: text(field.displayName) || fieldId,
				source_type: text(field.type), system: field.systemField === true,
			};
			if (text(field.referencedCollection)) projected.reference_collection = text(field.referencedCollection);
			if (projected.reference_collection && Object.keys(object(recordsByCollection[projected.reference_collection])).length === 0) {
				diagnostics.push({ code: 'collection_relationship_inventory_unobserved', collection_id: id, field_id: fieldId });
			}
			const pattern = text(object(object(field.calculator).config).pattern, 2048);
			if (pattern) projected.route_pattern = pattern;
			fields.push(projected);
		}
		const sourceRecords = object(recordsByCollection[id]);
		const recordEntries = Object.entries(sourceRecords).sort(([left], [right]) => left.localeCompare(right));
		if (recordEntries.length > MAX_RECORDS) diagnostics.push({ code: 'collection_records_truncated', collection_id: id });
		const records: SourceCollection['records'] = [];
		for (const [recordId, rawRecord] of recordEntries.slice(0, MAX_RECORDS)) {
			const record = object(rawRecord);
			if (!text(recordId) || record._id !== recordId || (record._publishStatus !== undefined && record._publishStatus !== 'PUBLISHED')) {
				diagnostics.push({ code: 'collection_record_unproven', collection_id: id, record_id: recordId });
				continue;
			}
			const values: ObjectValue = Object.create(null) as ObjectValue;
			const routes = new Set<string>();
			for (const field of fields) {
				if (!Object.hasOwn(record, field.id)) {
					if (field.reference_collection) diagnostics.push({ code: 'collection_relationship_value_unobserved', collection_id: id, record_id: recordId, field_id: field.id });
					continue;
				}
				try { values[field.id] = value(record[field.id]); } catch {
					diagnostics.push({ code: 'collection_record_value_unproven', collection_id: id, record_id: recordId, field_id: field.id });
					continue;
				}
				if (field.source_type === 'pagelink') {
					const route = sourceRoute(record[field.id], sourceUrl);
					if (route) routes.add(route);
					else diagnostics.push({ code: 'collection_record_route_unproven', collection_id: id, record_id: recordId, field_id: field.id });
				}
			}
			records.push({ id: recordId, values, source_routes: [...routes].sort() });
		}
		const datasets: SourceCollection['datasets'] = [];
		for (const [datasetId, rawDataset] of Object.entries(object(data.recordInfosByDatasetId)).slice(0, MAX_RECORDS)) {
			const dataset = object(rawDataset);
			const ids = Array.isArray(dataset.itemIds) ? dataset.itemIds : [];
			// Do not infer the collection of empty, mixed, or cross-collection ambiguous datasets.
			if (ids.length === 0 || ids.length > MAX_RECORDS || !ids.every(itemId => typeof itemId === 'string' && Object.hasOwn(sourceRecords, itemId))) continue;
			if (Object.entries(recordsByCollection).some(([otherId, rows]) => otherId !== id && ids.some(itemId => Object.hasOwn(object(rows), itemId as string)))) continue;
			const size = object(dataset.datasetSize);
			datasets.push({ id: datasetId, total: count(size.total), loaded: count(size.loaded), record_ids: [...new Set(ids as string[])] });
		}
		const retainedIds = new Set(records.map(record => record.id));
		const datasetComplete = datasets.length > 0 && datasets.every(dataset => dataset.total !== null && dataset.total === dataset.loaded && dataset.loaded === dataset.record_ids.length && dataset.record_ids.every(recordId => retainedIds.has(recordId)));
		if (!datasetComplete) diagnostics.push({ code: 'collection_dataset_coverage_unproven', collection_id: id });
		collections.push({
			id, label: text(schema.displayName) || id, display_field: text(schema.displayField), fields, records, datasets,
			coverage: { observed_records: recordEntries.length, retained_records: records.length, dataset_complete: datasetComplete, scope: 'observed_datasets' },
		});
	}
	const evidence: SourceCollections = { schema: SOURCE_COLLECTIONS_SCHEMA, source_url: sourceUrl, collections, diagnostics };
	if (Buffer.byteLength(JSON.stringify(evidence)) > MAX_EVIDENCE_BYTES) {
		return { schema: SOURCE_COLLECTIONS_SCHEMA, source_url: sourceUrl, collections: [], diagnostics: [{ code: 'collection_evidence_bound_exceeded' }] };
	}
	return evidence;
}

export function preserveWixCollections(html: string): string {
	const evidence = wixCollectionsFromHtml(html);
	if (!evidence) return html;
	const $ = cheerio.load(html);
	$('script[data-dla-source-evidence="collections"]').remove();
	const json = JSON.stringify(evidence).replace(/</g, '\\u003c');
	$('head').append(`<script type="application/json" data-dla-source-evidence="collections">${json}</script>`);
	return $.html();
}
