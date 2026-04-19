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

  describe('studio mode', () => {
    it('inlines the WXR via a literal resource (bypasses WP-CLI IPC)', () => {
      const dir = mkDir();
      const wxrContent = '<?xml version="1.0"?><rss><channel><item><title>Hello</title></item></channel></rss>';
      writeFileSync(join(dir, 'output.wxr'), wxrContent);

      const bp = buildBlueprint({ outputDir: dir, mode: 'studio' });

      const importWxr = bp.steps.find((s) => s.step === 'importWxr') as any;
      expect(importWxr).toBeDefined();
      expect(importWxr.file.resource).toBe('literal');
      expect(importWxr.file.name).toBe('output.wxr');
      expect(importWxr.file.contents).toBe(wxrContent);
    });

    it('installs wordpress-importer before importWxr', () => {
      const dir = mkDir();
      writeFileSync(join(dir, 'output.wxr'), '<rss/>');

      const bp = buildBlueprint({ outputDir: dir, mode: 'studio' });
      const steps = bp.steps.map((s) => s.step);
      const importerIdx = bp.steps.findIndex(
        (s) => s.step === 'installPlugin' && (s as any).pluginData?.slug === 'wordpress-importer',
      );
      const importWxrIdx = steps.indexOf('importWxr');
      expect(importerIdx).toBeLessThan(importWxrIdx);
    });

    it('installs WooCommerce when products.csv exists but skips inline importer for it', () => {
      const dir = mkDir();
      writeFileSync(join(dir, 'output.wxr'), '<rss/>');
      writeFileSync(join(dir, 'products.csv'), 'name\nfoo');

      const bp = buildBlueprint({ outputDir: dir, mode: 'studio' });
      const hasWoo = bp.steps.some(
        (s) => s.step === 'installPlugin' && (s as any).pluginData?.slug === 'woocommerce',
      );
      const hasWpCli = bp.steps.some((s) => s.step === 'wp-cli');
      expect(hasWoo).toBe(true);
      // Studio blueprint does NOT contain wp-cli steps — product CSV import
      // happens out-of-band via `studio wp` in startStudioPreview.
      expect(hasWpCli).toBe(false);
    });

    it('omits importWxr when the WXR is missing', () => {
      const dir = mkDir();
      const bp = buildBlueprint({ outputDir: dir, mode: 'studio' });
      expect(bp.steps.find((s) => s.step === 'importWxr')).toBeUndefined();
    });

    it('persistBlueprint writes blueprint.studio.json in studio mode', () => {
      const dir = mkDir();
      writeFileSync(join(dir, 'output.wxr'), '<rss/>');
      const p = persistBlueprint(dir, 'studio');
      expect(p).toBe(join(dir, 'playground', 'blueprint.studio.json'));
      expect(existsSync(p)).toBe(true);
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      expect(parsed.steps.find((s: { step: string }) => s.step === 'importWxr')).toBeDefined();
    });
  });
});
