import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { MAX_SOURCE_EVIDENCE_BYTES, renderSourceData, sourceEvidenceScript } from './source-data.js';

describe('inert source evidence', () => {
	it('retains typed neutral data without allowing an embedded end-tag to execute', () => {
		const source = { schema: 'source/collections/v1', text: '</script><script>globalThis.executed=true</script>' };
		const script = sourceEvidenceScript(JSON.stringify(source), 'collections')!;
		const $ = cheerio.load(renderSourceData([script]));
		expect($('script')).toHaveLength(1);
		expect($('script').attr('type')).toBe('application/json');
		expect(JSON.parse($('script').text())).toEqual(source);
	});
	it.each(['null', '[]', '"text"', '{}', '{invalid'])('rejects untyped or malformed evidence: %s', source => {
		expect(sourceEvidenceScript(source, 'collections')).toBeNull();
	});
	it('bounds the payload and rejects keys that cannot safely be rendered as metadata attributes', () => {
		const source = JSON.stringify({ schema: 'source/example/v1', value: 'x'.repeat(MAX_SOURCE_EVIDENCE_BYTES) });
		expect(sourceEvidenceScript(source, 'collections')).toBeNull();
		expect(sourceEvidenceScript('{"schema":"source/example/v1"}', 'bad" onload="run')).toBeNull();
	});
});
