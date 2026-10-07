/** Inert source metadata travels with HTML, independently of executable runtime. */
export interface SourceDataScript {
	type: 'application/ld+json' | 'application/json';
	json: string;
	key?: string;
}

export const MAX_SOURCE_EVIDENCE_BYTES = 256_000;
export const MAX_SOURCE_EVIDENCE_SCRIPTS = 8;

export function sourceEvidenceScript(source: string, key: string): SourceDataScript | null {
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key) || Buffer.byteLength(source) > MAX_SOURCE_EVIDENCE_BYTES) return null;
	try {
		const value: unknown = JSON.parse(source);
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
		const schema = (value as Record<string, unknown>).schema;
		if (typeof schema !== 'string' || !/^[a-z0-9][a-z0-9:/._-]{0,127}$/.test(schema)) return null;
		return { type: 'application/json', key, json: JSON.stringify(value).replace(/</g, '\\u003c') };
	} catch { return null; }
}

export function renderSourceData(scripts: readonly SourceDataScript[]): string {
	return scripts.map(script => `<script type="${script.type}"${script.key ? ` data-dla-source-evidence="${script.key}"` : ''}>${script.json}</script>`).join('');
}
