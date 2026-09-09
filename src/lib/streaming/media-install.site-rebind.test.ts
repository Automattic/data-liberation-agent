//
// Regression: media-stubs.json is per-EXTRACTION, not per-WP-SITE.
// ===============================================================
// Recovery workflow that bites: the first Studio replica is destroyed and a
// fresh site is created, then the SAME extraction output dir is re-run against
// the NEW wpRoot. Every stub still carries the OLD site's `wpPostId` +
// `localUrl`, so `installMediaForUrl`'s bucketing loop takes the
// already-installed shortcut (media-install.ts:252) and:
//   - copies no file into the new site's uploads,
//   - creates no attachment post in the new site,
//   - yet reports the item in `result.installed` with the stale postId/localUrl.
// The caller (installRunMediaMap → mediaUrlMap) then rewrites page HTML to
// /wp-content/uploads/... paths that don't exist on the new site → every image
// 404s while the run reports `mediaInstalled: N, mediaErrors: 0`.
//
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installMediaForUrl } from './media-install.js';
import { MediaStubStore } from '../resume-state/index.js';

const FIXTURE_TMP = join(process.cwd(), '.tmp-test');
mkdirSync(FIXTURE_TMP, { recursive: true });

const SUCCESS_RESPONSE = (
  entries: Array<{ sourceUrl: string; filename: string; postId: number; localUrl: string }>,
) =>
  `DLA_INSTALL_MEDIA_JSON_BEGIN\n${JSON.stringify({
    results: entries.map((e) => ({ ...e, reused: false })),
    errors: [],
  })}\nDLA_INSTALL_MEDIA_JSON_END\n`;

/**
 * Seed an extraction output dir whose stubs were installed against a PRIOR
 * (now destroyed) Studio site, and return a brand-new, empty wpRoot standing
 * in for the rebuilt site.
 */
function setupRebind() {
  const outputDir = mkdtempSync(join(FIXTURE_TMP, 'mi-rebind-'));
  mkdirSync(join(outputDir, 'media'), { recursive: true });
  const filePath = join(outputDir, 'media', 'a.jpg');
  writeFileSync(filePath, Buffer.from('fake'));
  // mtime drives the uploads year/month a real install copies into — pin it so
  // it matches the 2024/01 localUrl the mocked install-media.php reports.
  const stamp = new Date(2024, 0, 15, 12, 0, 0);
  utimesSync(filePath, stamp, stamp);

  // Site A: the destroyed replica. Its uploads dir + attachment post are gone.
  const oldWpRoot = join(outputDir, 'site-old', 'wordpress');
  mkdirSync(join(oldWpRoot, 'wp-content', 'uploads', '2024', '01'), { recursive: true });
  writeFileSync(join(oldWpRoot, 'wp-content', 'uploads', '2024', '01', 'a.jpg'), Buffer.from('fake'));

  // Site B: the freshly-created replacement. Empty uploads, empty media library.
  const newWpRoot = join(outputDir, 'site-new', 'wordpress');
  mkdirSync(newWpRoot, { recursive: true });

  return { outputDir, filePath, oldWpRoot, newWpRoot };
}

/** Resolve a reported localUrl (root-relative) to its on-disk path under a wpRoot. */
function uploadPathFor(wpRoot: string, localUrl: string): string {
  return join(wpRoot, localUrl.replace(/^\//, ''));
}

describe('installMediaForUrl — output dir re-run against a different WP site', () => {
  it('does not report media as installed on a site where the attachment does not exist', async () => {
    const { outputDir, filePath, oldWpRoot, newWpRoot } = setupRebind();
    try {
      // --- Run 1: install against site A. Establishes the stub state. ---
      const execA = vi.fn().mockResolvedValue({
        stdout: SUCCESS_RESPONSE([
          {
            sourceUrl: 'https://cdn/a.jpg',
            filename: 'a.jpg',
            postId: 42,
            localUrl: 'http://localhost:8881/wp-content/uploads/2024/01/a.jpg',
          },
        ]),
        stderr: '',
      });
      const store = MediaStubStore.load(outputDir);
      store.markSuccess('https://cdn/a.jpg', filePath);
      store.flush();
      await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot: oldWpRoot,
        _execFile: execA,
      });

      const afterA = MediaStubStore.load(outputDir).get('https://cdn/a.jpg');
      expect(afterA?.wpPostId).toBe(42);
      expect(afterA?.localUrl).toBe('/wp-content/uploads/2024/01/a.jpg');

      // Site A is destroyed. A new Studio site is built. The SAME output dir is
      // re-run against it — no state in media-stubs.json identifies site A.
      rmSync(join(outputDir, 'site-old'), { recursive: true, force: true });

      // --- Run 2: same output dir, brand-new empty site B. ---
      const execB = vi.fn().mockResolvedValue({
        stdout: SUCCESS_RESPONSE([
          {
            sourceUrl: 'https://cdn/a.jpg',
            filename: 'a.jpg',
            postId: 7,
            localUrl: 'http://localhost:8882/wp-content/uploads/2024/01/a.jpg',
          },
        ]),
        stderr: '',
      });
      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot: newWpRoot,
        _execFile: execB,
      });

      // The core invariant a correct implementation must hold: anything the
      // caller is told is "installed" must actually resolve on the site it was
      // installed into — that is what feeds the URL rewrite map.
      for (const item of result.installed) {
        expect(
          existsSync(uploadPathFor(newWpRoot, item.localUrl)),
          `reported installed ${item.sourceUrl} -> ${item.localUrl} (postId ${item.postId}), ` +
            `but no such file exists under the target site ${newWpRoot}`,
        ).toBe(true);
      }

      // And the attachment must have been (re-)created in the new site.
      expect(execB, 'install-media.php never ran against the rebuilt site').toHaveBeenCalled();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('re-installs a legacy stub whose wpPostId names no known site', async () => {
    // Same stale-postId condition, but the stub predates site binding entirely
    // (and localUrl persistence). Its id cannot be attributed to any site, so
    // it must install rather than be trusted — the install path is idempotent,
    // so this costs at most one redundant exec on a site that already has it.
    const { outputDir, filePath, newWpRoot } = setupRebind();
    try {
      const store = MediaStubStore.load(outputDir);
      store.markSuccess('https://cdn/a.jpg', filePath);
      store.recordWpPostId('https://cdn/a.jpg', 42); // no wpRoot, no recordLocalUrl
      store.flush();

      const exec = vi.fn().mockResolvedValue({
        stdout: SUCCESS_RESPONSE([
          {
            sourceUrl: 'https://cdn/a.jpg',
            filename: 'a.jpg',
            postId: 7,
            localUrl: 'http://localhost:8882/wp-content/uploads/2024/01/a.jpg',
          },
        ]),
        stderr: '',
      });
      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot: newWpRoot,
        _execFile: exec,
      });

      expect(exec).toHaveBeenCalled();
      expect(result.skipped).toHaveLength(0);
      expect(result.installed).toHaveLength(1);
      for (const item of result.installed) {
        expect(existsSync(uploadPathFor(newWpRoot, item.localUrl))).toBe(true);
      }
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('re-installs when the site is destroyed and recreated at the SAME path', async () => {
    // The headline field workflow from the issue: the broken Studio site is
    // deleted and re-created under the same name, so it lands back at the same
    // ~/Studio/<Name> path with an empty uploads dir and an empty media
    // library. A recorded-wpRoot string comparison matches, so the stub is
    // still trusted — no file is copied, no attachment created, and the stale
    // localUrl is rewritten into the markup as a 404.
    const outputDir = mkdtempSync(join(FIXTURE_TMP, 'mi-samepath-'));
    try {
      mkdirSync(join(outputDir, 'media'), { recursive: true });
      const filePath = join(outputDir, 'media', 'a.jpg');
      writeFileSync(filePath, Buffer.from('fake'));
      const stamp = new Date(2024, 0, 15, 12, 0, 0);
      utimesSync(filePath, stamp, stamp);

      const sitePath = join(outputDir, 'site');
      const wpRoot = join(sitePath, 'wordpress');
      mkdirSync(wpRoot, { recursive: true });

      const phpOk = (postId: number) => ({
        stdout: SUCCESS_RESPONSE([
          {
            sourceUrl: 'https://cdn/a.jpg',
            filename: 'a.jpg',
            postId,
            localUrl: 'http://localhost:8881/wp-content/uploads/2024/01/a.jpg',
          },
        ]),
        stderr: '',
      });

      // --- Run 1: install into the original site at `wpRoot`. ---
      const store = MediaStubStore.load(outputDir);
      store.markSuccess('https://cdn/a.jpg', filePath);
      store.flush();
      await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        _execFile: vi.fn().mockResolvedValue(phpOk(42)),
      });
      expect(existsSync(uploadPathFor(wpRoot, '/wp-content/uploads/2024/01/a.jpg'))).toBe(true);

      // The site is deleted and re-created with the same name → same path,
      // empty uploads. The extraction output dir is untouched.
      rmSync(sitePath, { recursive: true, force: true });
      mkdirSync(wpRoot, { recursive: true });

      // --- Run 2: same outputDir, same wpRoot, empty site. ---
      const execB = vi.fn().mockResolvedValue(phpOk(7));
      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        _execFile: execB,
      });

      for (const item of result.installed) {
        expect(
          existsSync(uploadPathFor(wpRoot, item.localUrl)),
          `reported installed ${item.sourceUrl} -> ${item.localUrl} (postId ${item.postId}), ` +
            `but no such file exists under the recreated site ${wpRoot}`,
        ).toBe(true);
      }
      expect(execB, 'install-media.php never ran against the recreated site').toHaveBeenCalled();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('does not report another site\'s postId even when the file is present here', async () => {
    // Two sites built from the same extraction: this one already has the
    // uploads file (installed on its own earlier pass), but the stub's
    // wpPostId was stamped by the OTHER site. `installed[].postId` is surfaced
    // to callers (mcp-server/handlers/media-install.ts), so it must describe
    // an attachment in the site being reported on — the file being on disk
    // says nothing about the attachment id.
    const { outputDir, filePath, oldWpRoot, newWpRoot } = setupRebind();
    try {
      mkdirSync(join(newWpRoot, 'wp-content', 'uploads', '2024', '01'), { recursive: true });
      writeFileSync(uploadPathFor(newWpRoot, '/wp-content/uploads/2024/01/a.jpg'), Buffer.from('fake'));

      const store = MediaStubStore.load(outputDir);
      store.markSuccess('https://cdn/a.jpg', filePath);
      store.recordWpPostId('https://cdn/a.jpg', 42, oldWpRoot);
      store.recordLocalUrl('https://cdn/a.jpg', '/wp-content/uploads/2024/01/a.jpg');
      store.flush();

      const exec = vi.fn().mockResolvedValue({
        stdout: SUCCESS_RESPONSE([
          {
            sourceUrl: 'https://cdn/a.jpg',
            filename: 'a.jpg',
            postId: 7,
            localUrl: 'http://localhost:8882/wp-content/uploads/2024/01/a.jpg',
          },
        ]),
        stderr: '',
      });
      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot: newWpRoot,
        _execFile: exec,
      });

      expect(exec, 'the stale postId was trusted instead of resolved against this site').toHaveBeenCalled();
      expect(result.installed.map((i) => i.postId)).toEqual([7]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('honors a legacy stub whose uploads file is still present on the target site', async () => {
    // Complement of the above: the stub predates site binding (wpPostId +
    // localUrl, no wpRoot) and <outputDir>/media has since been pruned, but the
    // file it names IS on this site's disk. There is nothing left to re-install
    // from, so dropping it would strand the page on its CDN URL — worse than
    // trusting the mapping, which demonstrably resolves.
    const outputDir = mkdtempSync(join(FIXTURE_TMP, 'mi-legacy-present-'));
    try {
      mkdirSync(join(outputDir, 'media'), { recursive: true });
      const filePath = join(outputDir, 'media', 'a.jpg');
      writeFileSync(filePath, Buffer.from('fake'));

      const wpRoot = join(outputDir, 'site', 'wordpress');
      mkdirSync(join(wpRoot, 'wp-content', 'uploads', '2024', '01'), { recursive: true });
      writeFileSync(uploadPathFor(wpRoot, '/wp-content/uploads/2024/01/a.jpg'), Buffer.from('fake'));

      const store = MediaStubStore.load(outputDir);
      store.markSuccess('https://cdn/a.jpg', filePath);
      store.recordWpPostId('https://cdn/a.jpg', 42); // legacy: no wpRoot recorded
      store.recordLocalUrl('https://cdn/a.jpg', '/wp-content/uploads/2024/01/a.jpg');
      store.flush();

      // The media cache was pruned after the successful install.
      rmSync(filePath, { force: true });

      const exec = vi.fn();
      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        _execFile: exec,
      });

      expect(exec).not.toHaveBeenCalled();
      expect(result.installed).toEqual([
        {
          sourceUrl: 'https://cdn/a.jpg',
          postId: 42,
          localUrl: '/wp-content/uploads/2024/01/a.jpg',
          localPath: filePath,
        },
      ]);
      expect(result.skipped).toHaveLength(0);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
