import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildBlueprint, persistBlueprint } from './blueprint-builder.js';

let tempDirs: string[] = [];

function mkDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bp-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

describe('buildBlueprint', () => {
  it('generates a content-only blueprint when products.csv is absent', () => {
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    mkdirSync(join(dir, 'media'));

    const bp = buildBlueprint({ outputDir: dir });

    expect(bp.landingPage).toBe('/');
    expect(bp.login).toBe(true);
    expect(bp.preferredVersions.wp).toBe('latest');
    expect(bp.preferredVersions.php).toBe('8.2');

    const stepNames = bp.steps.map((s) => s.step);
    expect(stepNames).toContain('importWxr');
    expect(stepNames).not.toContain('installPlugin');
    expect(stepNames).not.toContain('wp-cli');

    const importWxr = bp.steps.find((s) => s.step === 'importWxr') as any;
    expect(importWxr.file.resource).toBe('vfs');
    expect(importWxr.file.path).toBe('/wordpress/wp-content/uploads/liberation/output.wxr');
  });

  it('includes WooCommerce install + wp-cli import when products.csv exists', () => {
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    writeFileSync(join(dir, 'products.csv'), 'name\nfoo');
    mkdirSync(join(dir, 'media'));

    const bp = buildBlueprint({ outputDir: dir });

    const install = bp.steps.find(
      (s) => s.step === 'installPlugin' && (s as any).pluginData?.slug === 'woocommerce',
    );
    expect(install).toBeDefined();

    const wpcli = bp.steps.find((s) => s.step === 'wp-cli') as any;
    expect(wpcli.command).toContain('wp wc product_importer import');
    expect(wpcli.command).toContain('/wordpress/wp-content/uploads/liberation/products.csv');
  });

  it('honors DLA_PREVIEW_WP_VERSION env override', () => {
    const prev = process.env.DLA_PREVIEW_WP_VERSION;
    process.env.DLA_PREVIEW_WP_VERSION = '6.7';
    try {
      const dir = mkDir();
      writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
      mkdirSync(join(dir, 'media'));
      const bp = buildBlueprint({ outputDir: dir });
      expect(bp.preferredVersions.wp).toBe('6.7');
    } finally {
      if (prev === undefined) delete process.env.DLA_PREVIEW_WP_VERSION;
      else process.env.DLA_PREVIEW_WP_VERSION = prev;
    }
  });

  it('writes the blueprint to <outputDir>/playground/blueprint.json when persistBlueprint is called', () => {
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    mkdirSync(join(dir, 'media'));

    const p = persistBlueprint(dir);

    expect(p).toBe(join(dir, 'playground', 'blueprint.json'));
    expect(existsSync(p)).toBe(true);
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    expect(parsed.steps[0].step).toBe('importWxr');
  });
});
