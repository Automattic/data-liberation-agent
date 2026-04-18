import { existsSync } from 'node:fs';
import { resolve, join, normalize } from 'node:path';

const VIEWPORTS = ['desktop', 'mobile'] as const;
export type ViewportId = (typeof VIEWPORTS)[number];

export interface ArtifactPlan {
  needsLoad: boolean;
  captureFullpage: boolean;
  captureScrolled: boolean;
  captureHtml: boolean;
  paths: {
    fullpage: string;
    scrolled: string;
    html: string;
  };
}

export interface CapturePlan {
  desktop: ArtifactPlan;
  mobile: ArtifactPlan;
}

/** Reject outputDir paths that escape cwd or contain `..` after normalization. */
export function validateOutputDir(outputDir: string): void {
  const cwd = resolve(process.cwd());
  const abs = resolve(outputDir);
  const norm = normalize(outputDir);
  if (norm.split('/').includes('..') || norm.split('\\').includes('..')) {
    throw new Error(`outputDir contains '..' traversal: ${outputDir}`);
  }
  if (!abs.startsWith(cwd + '/') && abs !== cwd) {
    throw new Error(`outputDir is outside the working directory: ${outputDir} (resolved: ${abs}, cwd: ${cwd})`);
  }
}

/** Claim a slug, appending -2, -3, ... on collision. Mutates `seen`. */
export function claimSlug(base: string, seen: Map<string, number>): string {
  const existing = seen.get(base);
  if (existing === undefined) {
    seen.set(base, 1);
    return base;
  }
  const next = existing + 1;
  seen.set(base, next);
  return `${base}-${next}`;
}

/**
 * Given an outputDir + slug, decide which artifacts we still need to capture
 * for each viewport and whether we need to load the page at all.
 *
 *   viewport.needsLoad = true if ANY of its artifacts are missing (or force)
 *   → we load the page once and capture whatever's missing
 */
export function planArtifacts(args: {
  slug: string;
  outputDir: string;
  force: boolean;
}): CapturePlan {
  const plan = (viewport: ViewportId): ArtifactPlan => {
    const fullpage = join(args.outputDir, 'screenshots', viewport, `${args.slug}.png`);
    const scrolled = join(args.outputDir, 'screenshots', viewport, `${args.slug}.scrolled.png`);
    const html = join(args.outputDir, 'html', `${args.slug}.html`);
    const captureFullpage = args.force || !existsSync(fullpage);
    const captureScrolled = args.force || !existsSync(scrolled);
    // HTML is captured on the desktop pass only.
    const captureHtml = viewport === 'desktop' && (args.force || !existsSync(html));
    const needsLoad = captureFullpage || captureScrolled || captureHtml;
    return {
      needsLoad,
      captureFullpage,
      captureScrolled,
      captureHtml,
      paths: { fullpage, scrolled, html },
    };
  };
  return { desktop: plan('desktop'), mobile: plan('mobile') };
}
