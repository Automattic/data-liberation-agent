import { tenantHandleRouteScope } from '../adapters/tenant-handle.js';
import type { SiteRouteScope } from '../platform/types.js';
import { safeFetch } from '../lib/media-fetch/safe-fetch.js';
import { IntegrityError } from '../lib/failure-class.js';

/** Project sites own their first segment; user sites exclude Pages-enabled projects. */
export async function githubPagesRouteScope(
	sourceUrl: string,
	diagnostics: Array<{ code: string; url: string; reason: string }> = [],
): Promise<SiteRouteScope | undefined> {
	const entry = new URL(sourceUrl);
	if (!/^[^.]+\.github\.io$/.test(entry.hostname)) return undefined;
	if (entry.pathname !== '/') return tenantHandleRouteScope(sourceUrl);

	const scope: SiteRouteScope = { origin: entry.origin, pathPrefixes: ['/'] };
	const user = entry.hostname.split('.')[0];
	const endpoint = `https://api.github.com/users/${user}/repos`;
	const excludedPathPrefixes: string[] = [];
	try {
		let next: string | undefined = `${endpoint}?per_page=100`;
		const visited = new Set<string>();
		while (next) {
			if (visited.has(next)) throw new Error('Cyclic repository pagination'); // failure-class: operational
			visited.add(next);
			const response = await safeFetch(next, { headers: { Accept: 'application/vnd.github+json' }, timeoutMs: 10_000 });
			if (response.status !== 200) throw new Error(`GitHub repository lookup returned HTTP ${response.status}`); // failure-class: operational
			const repos: unknown = JSON.parse(response.body.toString('utf8'));
			if (!Array.isArray(repos) || repos.some(repo => !repo || typeof repo.name !== 'string' || typeof repo.has_pages !== 'boolean')) {
				throw new Error('Invalid GitHub repository response'); // failure-class: operational
			}
			for (const repo of repos) {
				if (repo.has_pages && repo.name.toLowerCase() !== entry.hostname) excludedPathPrefixes.push(`/${repo.name}`);
			}
			next = undefined;
			for (const link of (response.headers.get('link') ?? '').split(',')) {
				const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(link);
				if (!match) continue;
				const target = new URL(match[1]);
				if (`${target.origin}${target.pathname}` !== endpoint) throw new Error('Invalid repository pagination URL'); // failure-class: operational
				next = target.href;
			}
		}
		return { ...scope, excludedPathPrefixes };
	} catch (error) {
		// Network fetch and malformed API data can also raise TypeError/SyntaxError.
		if (error instanceof IntegrityError) throw error; // failure-class: integrity
		diagnostics.push({
			code: 'github_pages_scope_unavailable', url: sourceUrl,
			reason: `Could not enumerate Pages projects; retaining whole-origin scope: ${error instanceof Error ? error.message : String(error)}`,
		});
		return scope;
	}
}
