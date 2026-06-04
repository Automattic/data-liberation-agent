import type { Page } from 'playwright';

/**
 * Wait for a page to reach a stable state after load.
 *
 *   goto('load') ─▶ settleMs ─▶ networkidle best-effort (5s) ─▶ fonts.ready (4s) ─▶ done
 *
 * Networkidle is wrapped in try/catch because chatty analytics (GA, Intercom)
 * can hold it open indefinitely; we don't want that to block capture.
 *
 * The trailing font wait resolves FOIT (flash-of-invisible-text) BEFORE we
 * screenshot. Text styled with a custom @font-face — e.g. a Wix nav menu built
 * from an uploaded webfont — renders fully INVISIBLE during the font's block
 * period; capturing in that window drops the text from the screenshot (this is
 * exactly why source captures of Wix navs came back blank). It runs last, after
 * networkidle, so any font request issued by late hydration JS is already in
 * flight and document.fonts.ready waits for it to actually apply.
 */
export async function waitForStable(page: Page, settleMs: number = 1000): Promise<void> {
  await page.waitForLoadState('load');
  if (settleMs > 0) {
    await new Promise((r) => setTimeout(r, settleMs));
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 5_000 });
  } catch {
    /* best-effort — analytics can keep network busy forever */
  }
  await waitForFonts(page);
}

/**
 * Wait for web fonts to finish loading (or fail) so FOIT resolves before a
 * screenshot. Best-effort and timeout-bounded: a webfont that never settles
 * (or a hostile/blocked CDN) must not hang or fail the capture.
 */
export async function waitForFonts(page: Page, timeoutMs: number = 4_000): Promise<void> {
  try {
    await withEvaluateTimeout(
      // document.fonts.ready resolves once every in-use @font-face has loaded or
      // errored; map to a serializable value so playwright can return it.
      page.evaluate(() => document.fonts.ready.then(() => true)),
      timeoutMs,
    );
  } catch {
    /* best-effort — never block capture on a slow/blocked webfont */
  }
}

/**
 * Wait for in-flight CSS animations/transitions to finish so opacity/transform
 * states are fully settled before the screenshot.
 *
 * The motivating case: a scroll-reactive sticky header (Wix and others) fades on
 * scroll and transitions back when returned to the top. After `triggerLazyLoad`
 * scrolls back and re-fires a scroll event, that restore transition is in
 * flight; capturing mid-transition freezes the header at PARTIAL opacity — a Wix
 * nav caught at ~20% reads as "blank" even though the font already loaded and
 * `document.fonts.ready` resolved. This is distinct from FOIT ([[waitForFonts]]):
 * the glyphs ARE painting, the whole layer is half-faded. It also settles genuine
 * entrance reveals (sections that fade in on viewport entry).
 *
 * `getAnimations()` returns both CSSAnimation and CSSTransition objects, so
 * awaiting their `.finished` settles the transition. Infinite animations
 * (spinners, looping marquees) never finish and are excluded; the whole wait is
 * timeout-bounded so a long/stuck animation can't hang the capture.
 */
export async function waitForAnimations(page: Page, timeoutMs: number = 2_000): Promise<void> {
  try {
    await withEvaluateTimeout(
      page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            // `.finished` rejects if the animation is cancelled mid-flight; swallow
            // so one cancelled reveal doesn't reject the whole settle.
            .map((a) => a.finished.catch(() => undefined)),
        ).then(() => true),
      ),
      timeoutMs,
    );
  } catch {
    /* best-effort — never block capture on a slow/stuck animation */
  }
}

/**
 * Scroll from top to bottom in 500px increments with 200ms between steps, wait
 * for networkidle (5s max, best-effort), then RESTORE the top scroll state and
 * let the resulting transitions settle. Triggers lazy-loaded images so the
 * subsequent screenshot captures actual content instead of placeholders.
 *
 * Restoring the top state matters for scroll-reactive sticky headers: the
 * scroll-through above fades/hides them, and a bare `scrollTo(0, 0)` does NOT
 * un-hide them — the builder's scroll handler only recomputes the at-top state
 * on a real scroll EVENT. So we scroll to top AND dispatch a `scroll` event,
 * then [[waitForAnimations]] for the restore (and any viewport-entry reveals) to
 * finish. Without this the header is captured faded — the root cause of "blank"
 * Wix nav captures (verified: header section opacity 1 at load → 0 after a bare
 * lazy scroll → back to 1 after scrollTo(0,0)+scroll-event).
 */
export async function triggerLazyLoad(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      const step = 500;
      const pauseMs = 200;
      const total = document.documentElement.scrollHeight;
      for (let y = 0; y < total; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, pauseMs));
      }
      window.scrollTo(0, total);
    });
    try {
      await page.waitForLoadState('networkidle', { timeout: 5_000 });
    } catch { /* best-effort */ }
    // Return to top AND fire a scroll event so scroll-reactive headers recompute
    // their at-top (un-faded) state — scrollTo alone doesn't trigger their handler.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      window.dispatchEvent(new Event('scroll'));
    });
    // Scroll handlers are throttled/debounced (~200ms observed on Wix), so the
    // restore transition starts a beat AFTER the event — waitForAnimations would
    // otherwise sample before it begins and return early. Give the handler time
    // to kick the transition off, then wait for that transition to finish.
    await new Promise((r) => setTimeout(r, 400));
    await waitForAnimations(page);
  } catch {
    /* if the page crashes or blocks our script, don't fail the capture */
  }
}

/**
 * Race a page.evaluate promise against a hard timeout. Chatty scripts or
 * hostile origins shouldn't hang the capture indefinitely.
 */
export async function withEvaluateTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`evaluate timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Overlay dismissal (takeover modals + cookie/consent banners)
// ===========================================================================
// A source site's takeover modal (ad/newsletter popup) or consent banner gets
// captured as part of the "true" page unless we dismiss it before capture.
// Detection runs in the browser and returns serializable descriptors; the
// scoring/selection below is pure Node so it is unit-testable without a browser.
// ---------------------------------------------------------------------------

/** One fixed/sticky candidate element, as measured in the page. */
export interface OverlayCandidate {
  idx: number;               // matches the in-page data-lib-overlay stamp
  selector: string;          // best-effort CSS path, for logging
  role: string | null;       // role attribute
  ariaModal: boolean;        // aria-modal="true"
  zIndex: number;            // computed z-index, non-numeric → 0
  coverageRatio: number;     // boundingBox area / viewport area, clamped 0..1
  hasBackdrop: boolean;      // a sibling fixed, ≥90%-coverage, semi-opaque layer exists
  vendorHint: boolean;       // id/class matches a popup-vendor pattern
  text: string;              // lowercased textContent, truncated
  ariaLabel: string | null;  // lowercased aria-label
  hasCloseAffordance: boolean; // a visible close control exists in the subtree
}

/** Page-global scroll-lock state (one modal locking scroll affects the page). */
export interface ScrollLockState {
  active: boolean;
}

/** What detectOverlays returns: candidates + the page scroll-lock state. */
export interface OverlayDetection {
  candidates: OverlayCandidate[];
  scrollLock: ScrollLockState;
}

/** A candidate that selection decided IS an overlay, with how it scored. */
export interface OverlayTarget {
  idx: number;
  kind: 'takeover' | 'consent';
  score: number;
  signals: string[];
  selector: string;
  hasCloseAffordance: boolean;
}

/** A record of one overlay we dismissed (returned + logged for observability). */
export interface DismissedOverlay {
  selector: string;
  method: 'close-click' | 'escape' | 'remove';
  kind: 'takeover' | 'consent';
  score: number;
  signals: string[];
}

export interface DismissOverlaysOpts {
  /** Max detect→dismiss rounds (stacked overlays). Default 3. */
  maxRounds?: number;
}

/** A candidate scoring this or higher is treated as a takeover modal. */
export const OVERLAY_THRESHOLD = 4;

/**
 * Score a candidate from its signals. Pure — the browser supplies the measured
 * descriptor + page scroll-lock state. scroll-lock is applied as a flat +3 to
 * every candidate (page-global evidence that something locked scroll); benign
 * chrome stays ≤3 because it lacks the other signals, so the threshold of 4
 * keeps it. Documented risk: a legitimately full-screen scroll-locking
 * experience (coverage≥90 + lock = 6) would be dismissed.
 */
export function scoreOverlay(
  c: OverlayCandidate,
  scrollLock: ScrollLockState,
): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];
  if (c.ariaModal || c.role === 'dialog' || c.role === 'alertdialog') {
    score += 3;
    signals.push('dialog');
  }
  if (scrollLock.active) {
    score += 3;
    signals.push('scroll-lock');
  }
  if (c.coverageRatio >= 0.9) {
    score += 3;
    signals.push('coverage>=90');
  } else if (c.coverageRatio >= 0.5) {
    score += 2;
    signals.push('coverage>=50');
  }
  if (c.zIndex >= 100000) {
    score += 2;
    signals.push('z>=1e5');
  } else if (c.zIndex >= 1000) {
    score += 1;
    signals.push('z>=1000');
  }
  if (c.hasBackdrop) {
    score += 1;
    signals.push('backdrop');
  }
  if (c.vendorHint) {
    score += 1;
    signals.push('vendor');
  }
  return { score, signals };
}

const CONSENT_TEXT_RE = /\bcookies?\b|consent|gdpr|ccpa|accept all|privacy (policy|preferences)/i;
const CONSENT_VENDOR_RE = /onetrust|cookiebot|usercentrics|termly|osano|trustarc|cookieyes/i;

/**
 * A looser, separate classifier for cookie/consent banners. They frequently do
 * NOT lock scroll and are thin strips, so they won't clear the takeover score;
 * we flag them by consent keywords / known vendors in their text/aria/selector.
 */
export function isConsentBanner(c: OverlayCandidate): boolean {
  const hay = `${c.text} ${c.ariaLabel ?? ''} ${c.selector}`.toLowerCase();
  return CONSENT_TEXT_RE.test(hay) || CONSENT_VENDOR_RE.test(hay);
}
