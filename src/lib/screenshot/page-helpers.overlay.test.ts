import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  scoreOverlay,
  OVERLAY_THRESHOLD,
  isConsentBanner,
  selectOverlayTargets,
  dismissOverlays,
  type OverlayCandidate,
  type ScrollLockState,
  type OverlayDetection,
} from './page-helpers.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

// A fully benign fixed/sticky element (e.g. a sticky site header).
const benign = (over: Partial<OverlayCandidate> = {}): OverlayCandidate => ({
  idx: 0,
  selector: 'header.site',
  role: null,
  ariaModal: false,
  zIndex: 100,
  coverageRatio: 0.08,
  hasBackdrop: false,
  vendorHint: false,
  text: 'home about contact',
  ariaLabel: null,
  hasCloseAffordance: false,
  ...over,
});
const noLock: ScrollLockState = { active: false };
const lock: ScrollLockState = { active: true };

describe('scoreOverlay', () => {
  it('scores a klaviyo-shaped modal above the takeover threshold', () => {
    const modal = benign({
      selector: 'div.klaviyo-form',
      role: 'dialog',
      ariaModal: true,
      zIndex: 10000001,
      coverageRatio: 0.7,
      vendorHint: true,
    });
    const { score, signals } = scoreOverlay(modal, lock);
    // dialog(3) + scroll-lock(3) + coverage>=50(2) + z>=1e5(2) + vendor(1) = 11
    expect(score).toBe(11);
    expect(score).toBeGreaterThanOrEqual(OVERLAY_THRESHOLD);
    expect(signals).toEqual(
      expect.arrayContaining(['dialog', 'scroll-lock', 'coverage>=50', 'z>=1e5', 'vendor']),
    );
  });

  it('keeps a benign sticky header below threshold even when scroll is locked elsewhere', () => {
    // scroll-lock alone (+3) must not push generic chrome over the line.
    expect(scoreOverlay(benign(), lock).score).toBe(3);
    expect(scoreOverlay(benign(), lock).score).toBeLessThan(OVERLAY_THRESHOLD);
  });

  it('keeps a bare role=dialog tooltip (no lock, small, low z) below threshold', () => {
    const tip = benign({ role: 'dialog', coverageRatio: 0.05, zIndex: 50 });
    expect(scoreOverlay(tip, noLock).score).toBe(3);
  });

  it('keeps a fixed full-screen parallax background below threshold without scroll-lock', () => {
    const bg = benign({ coverageRatio: 1, zIndex: 0 });
    expect(scoreOverlay(bg, noLock).score).toBe(3); // coverage>=90 only
  });
});

describe('isConsentBanner', () => {
  it('flags a banner by consent keyword in its text', () => {
    expect(isConsentBanner(benign({ text: 'we use cookies to improve your experience' }))).toBe(true);
  });

  it('flags a banner by a known consent vendor in its selector', () => {
    expect(isConsentBanner(benign({ selector: 'div#onetrust-banner-sdk', text: 'manage preferences' }))).toBe(true);
  });

  it('does not flag a generic newsletter modal as a consent banner', () => {
    expect(isConsentBanner(benign({ text: 'join our list for 10 percent off', selector: 'div.popup' }))).toBe(false);
  });

  it('flags a banner by the singular cookie keyword', () => {
    expect(isConsentBanner(benign({ text: 'this site uses a cookie' }))).toBe(true);
  });
});

describe('selectOverlayTargets', () => {
  it('returns takeovers (highest score first) then consent banners, dropping benign chrome', () => {
    const detection: OverlayDetection = {
      scrollLock: { active: true },
      candidates: [
        benign({ idx: 0, selector: 'header.site' }),                       // benign → dropped
        benign({ idx: 1, selector: 'div.klaviyo', role: 'dialog', ariaModal: true, coverageRatio: 0.7, zIndex: 10000001, vendorHint: true }), // strong takeover
        benign({ idx: 2, selector: 'div.cookie-bar', text: 'we use cookies', coverageRatio: 0.09, zIndex: 50 }), // consent (score 3, below threshold)
        benign({ idx: 3, selector: 'div.modal', role: 'dialog', coverageRatio: 0.6 }), // weaker takeover (3+3+2=8 with lock)
      ],
    };
    const targets = selectOverlayTargets(detection);
    expect(targets.map((t) => t.idx)).toEqual([1, 3, 2]); // takeovers by score desc, then consent
    expect(targets[0].kind).toBe('takeover');
    expect(targets[2].kind).toBe('consent');
    expect(targets[2].signals).toContain('consent');
  });

  it('returns nothing for a page of only benign fixed chrome', () => {
    const detection: OverlayDetection = {
      scrollLock: { active: false },
      candidates: [benign({ idx: 0 }), benign({ idx: 1, selector: 'footer.site' })],
    };
    expect(selectOverlayTargets(detection)).toEqual([]);
  });

  it('routes an above-threshold candidate that also reads as consent to takeovers (not consent)', () => {
    const detection: OverlayDetection = {
      scrollLock: { active: true },
      candidates: [
        benign({ idx: 0, selector: 'div.gdpr-wall', text: 'we use cookies', role: 'dialog', coverageRatio: 0.95 }),
      ],
    };
    const targets = selectOverlayTargets(detection);
    expect(targets).toHaveLength(1);
    expect(targets[0].kind).toBe('takeover');
  });
});

// A scroll-locking newsletter modal with a working close button, a backdrop, and
// — crucially — a benign sticky header that must survive dismissal untouched.
const MODAL_CLOSE_FIXTURE = `<!doctype html><html><head><style>
  body.locked { overflow: hidden; }
  #hdr { position: sticky; top: 0; height: 60px; z-index: 100; background: #eee; }
  #bg  { position: fixed; inset: 0; z-index: 2147482000; background: rgba(0,0,0,.5); }
  #m   { position: fixed; inset: 0; z-index: 2147483000; background: #fff; }
</style></head><body class="locked">
  <header id="hdr">site nav</header>
  <div id="bg"></div>
  <div id="m" role="dialog" aria-modal="true">
    <button aria-label="Close" id="x">×</button>
    <p>Join our fictional newsletter</p>
  </div>
  <main style="height:3000px">content</main>
  <script>
    document.getElementById('x').addEventListener('click', function () {
      document.getElementById('m').remove();
      document.getElementById('bg').remove();
      document.body.classList.remove('locked');
    });
  </script>
</body></html>`;

describe('dismissOverlays — Tier 1 graceful close (Playwright)', () => {
  it('clicks the modal close button, restoring scroll and leaving chrome + no stamps', async () => {
    const page = await browser.newPage();
    await page.setContent(MODAL_CLOSE_FIXTURE);
    try {
      const dismissed = await dismissOverlays(page);

      expect(dismissed).toHaveLength(1);
      expect(dismissed[0].method).toBe('close-click');
      expect(dismissed[0].kind).toBe('takeover');

      // modal + backdrop gone, scroll restored
      expect(await page.locator('#m').count()).toBe(0);
      expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
      // benign sticky header untouched
      expect(await page.locator('#hdr').count()).toBe(1);
      // no detection stamps leaked into the DOM (would otherwise be captured)
      expect(await page.evaluate(() =>
        document.querySelectorAll('[data-lib-overlay],[data-lib-overlay-close]').length)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('returns [] (never throws) on a page with no overlays', async () => {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body><main style="height:2000px">plain</main></body>');
    try {
      expect(await dismissOverlays(page)).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

// A scroll-locking modal with NO close control that closes on Escape.
const MODAL_ESCAPE_FIXTURE = `<!doctype html><html><head><style>
  body.locked { overflow: hidden; }
  #m { position: fixed; inset: 0; z-index: 999999; background: #fff; }
</style></head><body class="locked">
  <div id="m" role="dialog" aria-modal="true"><p>No close button here</p></div>
  <main style="height:3000px">content</main>
  <script>
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.getElementById('m').remove();
        document.body.classList.remove('locked');
      }
    });
  </script>
</body></html>`;

describe('dismissOverlays — Tier 2 Escape (Playwright)', () => {
  it('falls back to Escape when there is no close control', async () => {
    const page = await browser.newPage();
    await page.setContent(MODAL_ESCAPE_FIXTURE);
    try {
      const dismissed = await dismissOverlays(page);
      expect(dismissed).toHaveLength(1);
      expect(dismissed[0].method).toBe('escape');
      expect(await page.locator('#m').count()).toBe(0);
      expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
    } finally {
      await page.close();
    }
  });
});

// An un-closeable scroll-locking modal: no close control, no Escape handler.
const MODAL_STUBBORN_FIXTURE = `<!doctype html><html><head><style>
  body.locked { overflow: hidden; }
  #bg { position: fixed; inset: 0; z-index: 999998; background: rgba(0,0,0,.6); }
  #m  { position: fixed; inset: 0; z-index: 999999; background: #fff; }
</style></head><body class="locked">
  <div id="bg"></div>
  <div id="m" role="dialog" aria-modal="true"><p>You cannot close me</p></div>
  <main style="height:3000px">content</main>
</body></html>`;

describe('dismissOverlays — Tier 3 force remove (Playwright)', () => {
  it('removes the overlay + backdrop and force-unlocks scroll as a last resort', async () => {
    const page = await browser.newPage();
    await page.setContent(MODAL_STUBBORN_FIXTURE);
    try {
      const dismissed = await dismissOverlays(page);
      expect(dismissed).toHaveLength(1);
      expect(dismissed[0].method).toBe('remove');
      expect(await page.locator('#m').count()).toBe(0);
      expect(await page.locator('#bg').count()).toBe(0); // backdrop removed too
      expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
      expect(await page.evaluate(() => document.body.classList.contains('locked'))).toBe(false);
    } finally {
      await page.close();
    }
  });
});
