import { documentRequestUrl } from '../url/route-key.js';

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
}

/** Exact network addresses are deduped; aliases require observed source evidence. */
export class LinkedFrontier {
	readonly required = new Set<string>();
	readonly depths = new Map<string, number>();
	readonly diagnostics: FrontierDiagnostic[] = [];
	readonly limits: Required<LinkedPageLimits>;
	private readonly deadline: number;
	private readonly capturePageLimit?: number;

	constructor(limits: LinkedPageLimits & {capturePageLimit?: number} = {}, now = Date.now()) {
		this.capturePageLimit = limits.capturePageLimit;
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
		url = documentRequestUrl(url);
		if (this.depths.has(url) || (ownership === 'linked' && this.required.has(url))) return false;
		this.required.add(url);
		// Adapter inventory is already discovered. A proven redirect continues an
		// admitted route rather than opening a new linked-discovery branch. Both
		// still obey the caller's explicit whole-capture page cap.
		const reason = this.capturePageLimit !== undefined && this.depths.size >= this.capturePageLimit ? `capture limit=${this.capturePageLimit} exhausted; ${this.depths.size} addresses scheduled` :
			ownership !== 'linked' ? undefined :
			now >= this.deadline ? `timeoutMs=${this.limits.timeoutMs} exhausted` :
			depth > this.limits.maxDepth ? `depth=${depth} exceeds maxDepth=${this.limits.maxDepth}` :
			this.depths.size >= this.limits.maxPages ? `maxPages=${this.limits.maxPages} exhausted; ${this.depths.size} addresses scheduled` : undefined;
		if (reason) {
			if (!this.diagnostics.some(row => row.url === url && row.code === 'linked_page_budget_exhausted')) {
				this.diagnostics.push( { code: 'linked_page_budget_exhausted', url, reason } );
			}
			return false;
		}
		// An observed alias can prove a previously budget-rejected link belongs to
		// work already admitted. Its old omission is no longer true.
		for (let i = this.diagnostics.length - 1; i >= 0; i--) {
			if (this.diagnostics[i]!.url === url && this.diagnostics[i]!.code === 'linked_page_budget_exhausted') this.diagnostics.splice(i, 1);
		}
		this.depths.set(url, depth);
		return true;
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
