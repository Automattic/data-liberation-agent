import { describe, it, expect } from 'vitest';
import {
  scoreOverlay,
  OVERLAY_THRESHOLD,
  isConsentBanner,
  selectOverlayTargets,
  type OverlayCandidate,
  type ScrollLockState,
  type OverlayDetection,
} from './page-helpers.js';

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
});
