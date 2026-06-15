// src/lib/preview/studio-site.ts
//
// Provision a WordPress Studio site from the CLI so the local-static-site front
// door can create its own target the way /liberate stands up a WP target — one
// command drives everything (create site -> convert -> theme + live site).
//
// `studio site create` runs non-interactively with --start --skip-browser
// --skip-log-details and auto-generates an admin password when none is passed.
// Studio assigns a random port per site; callers resolve the live URL AFTER
// creation via `wp option get siteurl` (Studio ports are not stable).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/** Studio layouts: wp-content at the site root or under a wordpress/ subdir.
 * Returns the WP root (the dir containing wp-content) or null when absent. */
export function studioWpRoot(studioSitePath: string): string | null {
  if (existsSync(join(studioSitePath, 'wp-content'))) return studioSitePath;
  if (existsSync(join(studioSitePath, 'wordpress', 'wp-content'))) return join(studioSitePath, 'wordpress');
  return null;
}

/** Injectable exec seam (tests pass a stub; production uses execFile). */
export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface EnsureStudioSiteOpts {
  /** Display name for the new site (cosmetic; convert sets blogname properly later). */
  name: string;
  /** Absolute path where the site lives / will be created. */
  sitePath: string;
  /** Admin credentials — optional; Studio auto-generates a password if omitted. */
  adminUser?: string;
  adminPassword?: string;
  /** WordPress / PHP versions (Studio defaults: latest / 8.4). */
  wp?: string;
  php?: string;
  /** Injected exec for tests. */
  exec?: ExecFn;
}

export interface EnsureStudioSiteResult {
  /** The resolved WP root (dir containing wp-content). */
  wpRoot: string;
  /** true when this call created the site; false when it already existed. */
  created: boolean;
}

/**
 * Ensure a Studio site exists at `sitePath`, creating + starting it via
 * `studio site create` when absent. Idempotent: an existing WP install is
 * returned untouched (no recreate, no data loss). Throws if creation runs but
 * no wp-content materializes.
 */
export async function ensureStudioSite(opts: EnsureStudioSiteOpts): Promise<EnsureStudioSiteResult> {
  const existing = studioWpRoot(opts.sitePath);
  if (existing) return { wpRoot: existing, created: false };

  const exec = opts.exec ?? (execFileAsync as unknown as ExecFn);
  const args = [
    'site',
    'create',
    '--name',
    opts.name,
    '--path',
    opts.sitePath,
    '--start',
    '--skip-browser',
    '--skip-log-details',
  ];
  if (opts.wp) args.push('--wp', opts.wp);
  if (opts.php) args.push('--php', opts.php);
  if (opts.adminUser) args.push('--admin-username', opts.adminUser);
  if (opts.adminPassword) args.push('--admin-password', opts.adminPassword);

  // Creating a fresh WP install (download + DB init) can take a while.
  await exec('studio', args, { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });

  const wpRoot = studioWpRoot(opts.sitePath);
  if (!wpRoot) {
    throw new Error(`studio site create completed but no wp-content found under ${opts.sitePath}`);
  }
  return { wpRoot, created: true };
}
