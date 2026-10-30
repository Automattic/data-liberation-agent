import { documentRequestUrl } from '../url/route-key.js';
import type { SiteRouteScope } from '../../platform/types.js';
import { routeInScope, scopedRouteKey, validateRouteScope } from '../url/route-scope.js';
import { ROUTE_OMITTED_BY_BUDGET, routeBudgetReason } from '../route-budget.js';
import type { CanonicalRouteAlias } from '../route-aliases.js';
import { actionUrlExclusion } from '../url/action-url.js';
import { isNonDocumentUrl } from '../extraction/sitemap.js';

export interface LinkedPageLimits {
	maxPages?: number;
	maxDepth?: number;
	/** Bounds new linked-route admission, not completion of admitted captures. */
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
	/** Links to these routes were counted as satisfied by their canonical route, which the capture already holds. */
	aliasedTo?: CanonicalRouteAlias[];
}

/** Exact network addresses are deduped; aliases require observed source evidence. */
export class LinkedFrontier {
	readonly required = new Set<string>();
	readonly depths = new Map<string, number>();
	/** Link targets resolved to their canonical route instead of scheduled as their own page. */
	readonly aliased = new Map<string, string>();
	readonly diagnostics: FrontierDiagnostic[] = [];
	readonly limits: Required<LinkedPageLimits>;
	private readonly deadline: number;
	private readonly capturePageLimit?: number;

	constructor(limits: LinkedPageLimits & {capturePageLimit?: number} = {}, now = Date.now(), private readonly routeScope?: SiteRouteScope,
		/** Routes dropped before capture because their rel=canonical is another inventory route. */
		private readonly aliases: ReadonlyMap<string, string> = new Map(),
		private readonly aliasRecords: readonly CanonicalRouteAlias[] = []) {
		this.capturePageLimit = limits.capturePageLimit;
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

	admit(url: string, depth: number, now = Date.now(), ownership: 'linked' | 'inventory' | 'alias' = 'linked'): boolean {
		if (!routeInScope(url, this.routeScope)) return false;
		url = scopedRouteKey(url, this.routeScope);
		// A link to a route whose server-HTML canonical is another inventory route
		// counts as a link to that route: the capture holds its document, so the
		// alias never spends budget and its canonical carries the evidence.
		const aliasTarget = this.aliases.get(url);
		if (aliasTarget !== undefined) {
			if (!this.aliased.has(url)) this.aliased.set(url, aliasTarget);
			url = aliasTarget;
		}
		// Never visited, so never required evidence and never spending budget.
		const action = actionUrlExclusion(url);
		if (action) {
			this.omit(url, action.code, action.reason);
			return false;
		}
		if (isNonDocumentUrl(url)) {
			this.omit(url, 'non_document_url', 'URL identifies a non-document resource');
			return false;
		}
		if (this.depths.has(url) || (ownership === 'linked' && this.required.has(url))) return false;
		this.required.add(url);
		// The caller's route budget bounds every new route: adapter inventory and
		// linked discovery alike. A proven redirect continues a route already
		// admitted (the redirecting address is recorded as an alias, not a page),
		// so it does not spend budget and an in-budget route never loses its target.
		if (ownership !== 'alias' && this.capturePageLimit !== undefined && this.depths.size >= this.capturePageLimit) {
			this.omit(url, ROUTE_OMITTED_BY_BUDGET, routeBudgetReason(this.capturePageLimit));
			return false;
		}
		// Adapter inventory is already discovered and an alias continues an
		// admitted route; only linked discovery spends the frontier's own limits.
		const reason = ownership !== 'linked' ? undefined :
			now >= this.deadline ? `timeoutMs=${this.limits.timeoutMs} exhausted` :
			depth > this.limits.maxDepth ? `depth=${depth} exceeds maxDepth=${this.limits.maxDepth}` :
			this.depths.size >= this.limits.maxPages ? `maxPages=${this.limits.maxPages} exhausted; ${this.depths.size} addresses scheduled` : undefined;
		if (reason) {
			this.omit(url, 'linked_page_budget_exhausted', reason);
			return false;
		}
		// An observed alias can prove a previously budget-rejected link belongs to
		// work already admitted. Its old omission is no longer true.
		for (let i = this.diagnostics.length - 1; i >= 0; i--) {
			const row = this.diagnostics[i]!;
			if (row.url === url && (row.code === 'linked_page_budget_exhausted' || row.code === ROUTE_OMITTED_BY_BUDGET)) this.diagnostics.splice(i, 1);
		}
		this.depths.set(url, depth);
		return true;
	}

	private omit(url: string, code: string, reason: string): void {
		if (!this.diagnostics.some(row => row.url === url && row.code === code)) this.diagnostics.push({code, url, reason});
	}

	coverage(): LinkedPageCoverage {
		return {
			limits: this.limits,
			requiredUrls: [ ...this.required ],
			scheduled: this.depths.size,
			diagnostics: this.diagnostics,
			...( this.aliased.size ? { aliasedTo: this.aliasRecords.filter( ( { url } ) => this.aliased.has( documentRequestUrl( url ) ) ) } : {} ),
		};
	}
}
