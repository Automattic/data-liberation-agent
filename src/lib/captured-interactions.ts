import { createHash } from 'node:crypto';
import type { CapturedComponent } from './screenshot/component-states.js';

export const CAPTURED_INTERACTIONS_SCHEMA = 'blocks-engine-capture/captured-interactions/v3';
export interface ComponentReference { ref: string }
export interface ComponentPage {
	schema?: string;
	sourceUrl?: string;
	components?: Array<CapturedComponent | ComponentReference>;
}

/** Canonicalize JSON objects recursively; array order remains meaningful. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
		return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
	});
}

/** Only cross-page duplicates are shared. No route's component list is pruned. */
export function shareInteractionComponents<T extends { components: CapturedComponent[] }>(pages: readonly T[]) {
	const records = new Map<string, { component: CapturedComponent; pages: Set<number> }>();
	const keys = pages.map((page, index) => page.components.map(component => {
		const key = canonicalJson(component);
		const record = records.get(key) ?? { component, pages: new Set<number>() };
		record.pages.add(index);
		records.set(key, record);
		return key;
	}));
	const sharedComponents: Record<string, CapturedComponent> = {};
	const ids = new Map<string, string>();
	for (const [key, record] of records) {
		if (record.pages.size < 2) continue;
		const id = `sha256:${createHash('sha256').update(key).digest('hex')}`;
		ids.set(key, id);
		sharedComponents[id] = record.component;
	}
	return {
		sharedComponents,
		pages: pages.map((page, index) => ({
			...page,
			schema: CAPTURED_INTERACTIONS_SCHEMA,
			components: page.components.map((component, position) => {
				const id = ids.get(keys[index]![position]!);
				return id ? { ref: id } : component;
			}),
		})),
	};
}

/** Accept legacy inline pages and v3 refs; missing entries degrade only that component. */
export function resolveInteractionComponents<T extends ComponentPage>(report: {
	pages?: T[];
	sharedComponents?: Record<string, CapturedComponent>;
}) {
	const diagnostics: Array<{ code: 'unresolved_component_ref'; sourceUrl?: string; componentIndex: number; ref: string }> = [];
	const pages = (report.pages ?? []).map((page): Omit<T, 'components'> & { components: CapturedComponent[] } => ({
		...page,
		components: (page.components ?? []).flatMap((component, componentIndex): CapturedComponent[] => {
			if (!('ref' in component)) return [component];
			const shared = Object.hasOwn(report.sharedComponents ?? {}, component.ref) ? report.sharedComponents![component.ref] : undefined;
			if (shared) return [shared];
			diagnostics.push({ code: 'unresolved_component_ref', sourceUrl: page.sourceUrl, componentIndex, ref: component.ref });
			return [];
		}),
	}));
	return { pages, diagnostics };
}
