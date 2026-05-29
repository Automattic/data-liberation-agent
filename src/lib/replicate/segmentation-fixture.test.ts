/**
 * Browser-fixture harness for the in-browser section segmentation + cell grouping.
 *
 * The segmentation/cell-grouping geometry runs inside extractFull's page.evaluate
 * (live getComputedStyle/getBoundingClientRect), so it has no pure unit coverage
 * and is risky to change blind. This harness replays the REAL segmentation against
 * SNAPSHOTTED page HTML (output/<site>/html/<slug>.html) loaded offline via
 * setContent — Wix/Squarespace inline most layout CSS, so it lays out faithfully.
 * Scripts are stripped (the captured HTML is already the rendered DOM; we don't
 * want the builder runtime hitting the network).
 *
 * It's generic: point `specsForFixture` at any captured page. The assertions per
 * site live in their own describe block and are the TDD target for segmentation
 * fixes (assert the DESIRED section/cell shape, then fix the geometry).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractFull, type SectionSpec } from './section-extract.js';
import { measureSourceBands, measureSourceRepeats, scoreSegmentation } from './segmentation-parity.js';

// Discover snapshotted homepage fixtures generically (any output/<site>/html/).
// Gitignored output/ means these run locally where a liberation has been done;
// the harness itself is site-agnostic — point specsForFixture at any captured page.
function discoverHomepageFixtures(): string[] {
  const root = 'output';
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const site of readdirSync(root)) {
    const hp = join(root, site, 'html', 'homepage.html');
    if (existsSync(hp)) out.push(hp);
  }
  return out;
}
const FIXTURES = discoverHomepageFixtures();
const haveFixture = FIXTURES.length > 0;

let browser: Browser;
beforeAll(async () => {
  if (haveFixture) browser = await chromium.launch();
});
afterAll(async () => {
  if (browser) await browser.close();
});

async function analyzeFixture(path: string): Promise<{ specs: SectionSpec[]; score: ReturnType<typeof scoreSegmentation> }> {
  const html = readFileSync(path, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(300);
    const specs = await extractFull(page, {}, 20_000);
    const bands = await measureSourceBands(page);
    const repeats = await measureSourceRepeats(page);
    return { specs, score: scoreSegmentation(bands, specs, { repeats }) };
  } finally {
    await page.close();
  }
}

function summarize(specs: SectionSpec[]): string {
  return specs
    .map(
      (s, i) =>
        `${i} ${s.interactionModel} cells=${(s.cells ?? []).length} cols=${s.layout?.columnCount ?? '?'} h=[${s.headings.slice(0, 3).join(' | ')}]`,
    )
    .join('\n');
}

// Characterization: confirms the harness reproduces the live segmentation offline.
// This is the feasibility gate for TDD'ing segmentation fixes against fixtures.
describe.runIf(haveFixture)('segmentation fixture harness', () => {
  for (const fixture of FIXTURES) {
    it(`reproduces segmentation from ${fixture}`, async () => {
      const { specs, score } = await analyzeFixture(fixture);
      // eslint-disable-next-line no-console
      console.log(
        `\n--- ${fixture} (offline) ---\n` +
          summarize(specs) +
          `\nPARITY ${JSON.stringify(score)}\n`,
      );
      expect(specs.length).toBeGreaterThan(0);
      // No hard floor yet — this logs the baseline the dynamic ruleset must raise.
      // Once a fixture corpus exists, assert composite >= an agreed floor per fixture.
    }, 60_000);
  }
});
