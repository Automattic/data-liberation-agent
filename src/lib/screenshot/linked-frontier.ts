import { documentRequestUrl } from '../url/route-key.js';
import type { SiteRouteScope } from '../../platform/types.js';
import { routeInScope, validateRouteScope } from '../url/route-scope.js';

export interface LinkedPageLimits {
	maxPages?: number;
	maxDepth?: number;
	timeoutMs?: number;
}
export interface FrontierDiagnostic {
	code: string;
	url: string;
	reason: string;
}

export interface LinkedPageCoverage {
	limits: Required<LinkedPageLimits>;
	requiredUrls: string[];
	scheduled: number;
	diagnostics: FrontierDiagnostic[];
}

/** Exact network addresses are deduped; aliases require observed source evidence. */
export class LinkedFrontier {
	readonly required = new Set<string>();
	readonly depths = new Map<string, number>();
	readonly diagnostics: FrontierDiagnostic[] = [];
	readonly limits: Required<LinkedPageLimits>;
	private readonly deadline: number;

	constructor(limits: LinkedPageLimits = {}, now = Date.now(), private readonly routeScope?: SiteRouteScope) {
		if (routeScope) validateRouteScope(routeScope);
		this.limits = {
			maxPages: limits.maxPages ?? 256,
			maxDepth: limits.maxDepth ?? 8,
			timeoutMs: limits.timeoutMs ?? 1_800_000,
		};
		for (const [name, value] of Object.entries(this.limits)) {
			if (!Number.isSafeInteger(value) || value < (name === 'maxDepth' ? 0 : 1)) throw new Error(`Invalid linked-page ${name}`);
		}
		this.deadline = now + this.limits.timeoutMs;
	}

	admit(url: string, depth: number, now = Date.now()): boolean {
		if (!routeInScope(url, this.routeScope)) return false;
		url = documentRequestUrl(url);
		if (this.required.has(url)) return false;
		this.required.add(url);
		const reason = now >= this.deadline ? `timeoutMs=${this.limits.timeoutMs} exhausted` :
			depth > this.limits.maxDepth ? `depth=${depth} exceeds maxDepth=${this.limits.maxDepth}` :
			this.depths.size >= this.limits.maxPages ? `maxPages=${this.limits.maxPages} exhausted; ${this.depths.size} addresses scheduled` : undefined;
		if (reason) {
			this.diagnostics.push( { code: 'linked_page_budget_exhausted', url, reason } );
			return false;
		}
		this.depths.set(url, depth);
		return true;
	}

	expired(now = Date.now()): boolean { return now >= this.deadline; }

	recordTimeout(url: string): void {
		if (!this.diagnostics.some(row => row.url === url)) this.diagnostics.push({code: 'linked_page_budget_exhausted', url, reason: `timeoutMs=${this.limits.timeoutMs} exhausted before scheduled capture`});
	}

	coverage(): LinkedPageCoverage {
		return {
			limits: this.limits,
			requiredUrls: [ ...this.required ],
			scheduled: this.depths.size,
			diagnostics: this.diagnostics,
		};
	}
}
