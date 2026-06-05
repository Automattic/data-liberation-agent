export type PreviewPhase = 'download' | 'spawn' | 'probe' | 'import';

export interface PreviewPidRecord {
  pid: number;
  port: number;
  startedAt: string;
}

/**
 * One file inside a generated theme or block plugin. `relativePath` is rooted
 * at the theme/plugin directory (e.g. "templates/index.html", not
 * "wp-content/themes/foo/templates/index.html"). Paths containing ".." or
 * leading "/" are rejected at write time to avoid escaping the install root.
 */
export interface ReplicaFile {
  relativePath: string;
  content: string;
}

/**
 * A block plugin emitted alongside the replica theme. `slug` becomes the
 * plugin folder name (kebab-case). `files` are written under
 * `wp-content/plugins/<slug>/`. The plugin is activated via wp-cli after
 * files are written.
 */
export interface ReplicaBlockPlugin {
  slug: string;
  files: ReplicaFile[];
}

export interface StartPreviewOpts {
  outputDir: string;
  port?: number;
  open?: boolean;
  onPhase?: (phase: PreviewPhase) => void;
  detached?: boolean;
  /**
   * Optional generated theme to install + activate after content import.
   * When omitted, the preview runs with the default WP theme (current
   * `liberate_preview` behaviour).
   */
  themeFiles?: ReplicaFile[];
  /** Custom block plugins emitted alongside the theme. */
  blockPlugins?: ReplicaBlockPlugin[];
  /**
   * Theme directory name. Required when themeFiles is non-empty. Will be
   * the slug used by `wp theme activate`. Conventionally `<siteSlug>-replica`.
   */
  themeSlug?: string;
  /**
   * Tolerate a missing or empty `output.wxr`. Used by the streaming watch
   * loop's first preview call: site boots before extraction has produced
   * any items, so the URL can be surfaced to the user immediately.
   */
  allowEmptyWxr?: boolean;
  /**
   * Wipe the persistent SQLite + import-complete marker before starting so
   * the WXR is re-imported even when the persisted-state heuristic would
   * normally skip it. Used on the post-extraction preview call to land
   * the populated content into a site that was started empty.
   */
  forceReimport?: boolean;
  /**
   * Explicit Studio site name. When omitted, the name is derived from the
   * outputDir basename (e.g. `output/getsnooz.com` → `getsnooz-com`). Pass this
   * to honor the replica naming convention `<siteSlug>-replica` independent of
   * the output directory. Still uniqued against existing sites.
   */
  siteName?: string;
}

export type PreviewSource = 'studio';

export interface StartPreviewResult {
  status: 'ready' | 'failed';
  url?: string;
  port?: number;
  warnings?: string[];
  error?: string;
  logTail?: string[];
  source?: PreviewSource;
  siteName?: string;
  /**
   * On-disk WP root of the provisioned site (the dir that contains `wp-content`),
   * resolved via `resolveStudioWpRoot`. Lets callers (e.g. the carry reconstruct
   * driver) use this directly as `studioSitePath` instead of re-deriving
   * `~/Studio/<siteName>`.
   */
  path?: string;
}
