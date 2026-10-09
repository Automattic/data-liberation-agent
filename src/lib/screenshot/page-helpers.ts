import type { Page, Request } from 'playwright';
import { expandCollapsedContent, waitForAppWidgets } from './dynamic-content.js';
import { isSourcePromotion } from '../source-cleanup.js';

/** Slack given to an in-page step beyond its own budget before Node gives up on it. */
const EVALUATE_GRACE_MS = 5_000;

export interface SettleOutcome {
  /** `quiet`: the document met every requested condition; `deadline`: the bound fired first. */
  reason: 'quiet' | 'deadline';
  ms: number;
}

const readinessSinks = new WeakMap<Page, (wait: string, outcome: SettleOutcome) => void>();

/** Route every readiness outcome on `page` to `sink` (the capture's phase ledger). */
export function reportReadiness(page: Page, sink: (wait: string, outcome: SettleOutcome) => void): void {
  readinessSinks.set(page, sink);
}

/**
 * The one document readiness primitive: resolve once the document is quiet.
 *
 * Quiet means no DOM mutation for `quietMs` (the window starts at the call, so
 * an already-idle page costs one window) and, with `animations`, no in-flight
 * finite animation on the document timeline. Scroll- and view-timeline effects
 * advance with position and infinite effects never finish, so neither can be
 * awaited. A met condition is confirmed after two animation frames so a
 * completion handler that chains the next effect is still observed. The wait
 * is bounded by `timeoutMs` in the page and from Node, so a page that mutates
 * or animates forever, blocks scripts, or stops answering cannot hang capture.
 *
 * Deliberately generic: it asks only whether the document is still changing,
 * which is what any client-rendered stack reduces to. The outcome is reported
 * to the page's readiness sink and returned.
 */
export async function settleDocument(
  page: Page,
  wait: string,
  { quietMs, timeoutMs, animations = false }: { quietMs: number; timeoutMs: number; animations?: boolean },
): Promise<SettleOutcome> {
  const started = Date.now();
  let reason: SettleOutcome['reason'] = 'deadline';
  try {
    reason = await withEvaluateTimeout(
      page.evaluate(
        ({ quietMs, timeoutMs, animations }) =>
          new Promise<'quiet' | 'deadline'>((resolve) => {
            const started = performance.now();
            const deadline = started + timeoutMs;
            let lastMutation = started;
            const observer = new MutationObserver(() => { lastMutation = performance.now(); });
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
            const animating = () => animations && document.getAnimations().some((animation) =>
              animation.playState === 'running' && animation.timeline === document.timeline &&
              animation.effect?.getComputedTiming().iterations !== Infinity);
            const settled = () => performance.now() - lastMutation >= quietMs && !animating();
            const finish = (outcome: 'quiet' | 'deadline') => { observer.disconnect(); resolve(outcome); };
            const check = () => {
              if (performance.now() >= deadline) return finish('deadline');
              if (!settled()) return void setTimeout(check, 25);
              requestAnimationFrame(() => requestAnimationFrame(() => {
                if (settled()) finish('quiet');
                else if (performance.now() >= deadline) finish('deadline');
                else setTimeout(check, 25);
              }));
            };
            check();
          }),
        { quietMs, timeoutMs, animations },
      ),
      timeoutMs + 1_000,
    );
  } catch {
    /* best-effort: a blocked or crashed page falls through as a spent bound */
  }
  const outcome = { reason, ms: Date.now() - started };
  readinessSinks.get(page)?.(wait, outcome);
  return outcome;
}

/**
 * Wait for a page to reach a stable state after load.
 *
 *   goto('load') ─▶ networkidle + DOM quiescence concurrently ─▶ fonts.ready (4s)
 *     ─▶ declared loading state, if any ─▶ done
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
 *
 * The DOM-quiescence step runs after fonts because a client-rendered app can still be
 * assembling its own content well after 'load' fires and after networkidle has
 * either resolved or given up. 'load' only covers the document's own
 * script/stylesheet bundle, not whatever that bundle goes on to fetch and
 * render — a SPA that loads its data via its own async call (a server
 * function, a client-side data fetch) mounts a whole section of the page on
 * that response, at a moment 'load' knows nothing about. And a page embedding
 * a chatty third-party widget (e.g. a media player polling its own endpoints)
 * can hold networkidle open indefinitely without that hydration ever finishing
 * — see [[waitForRenderIdle]] for why network-quiet and render-complete are
 * different questions. Watching the DOM directly sidesteps both problems: a
 * MutationObserver on the whole document resolves once no mutation has landed
 * for `quietMs`, bounded by `domTimeoutMs` so a page that never stops mutating
 * (a live-updating ticker, a looping carousel re-render) cannot hang the
 * capture — it simply falls back to whatever the DOM looked like at the
 * deadline, same as every other best-effort wait in this file. A declared
 * loading state additionally keeps finite timer sequences from being frozen
 * during a quiet gap between text updates.
 */
export async function waitForStable(
  page: Page,
  domTimeoutMs: number = 5_000,
): Promise<void> {
  await page.waitForLoadState('load');
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {
      /* best-effort — analytics can keep network busy forever */
    }),
    settleDocument(page, 'stable', { quietMs: 500, timeoutMs: domTimeoutMs }),
  ]);
  await waitForFonts(page);
  await waitForDeclaredLoadingState(page);
}

/**
 * A quiet gap between timers does not mean that an authored loading sequence is
 * finished. Only wait when the document says it is still loading, and bound the
 * wait for pages whose loading state never clears.
 *
 * The document says so in one of two ways. It may declare itself busy
 * (`.loading` / `aria-busy` on the root or body). Or it may still be covered by
 * its loading screen: a fixed layer that spans the whole viewport, is what the
 * visitor hits at every sampled point, and carries no text. Such a layer hides
 * the page rather than being part of it, and the page removes it itself once
 * ready; measuring or serializing before then freezes the splash instead of the
 * page. Textual full-viewport layers (consent walls, menus, dialogs) are not
 * loading screens and are left to overlay handling.
 */
export async function waitForDeclaredLoadingState(page: Page, timeoutMs: number = 15_000): Promise<void> {
  try {
    const wasBusy = await withEvaluateTimeout(page.evaluate(({ timeoutMs }) => {
      // Name-preserving transpilers wrap these helpers in `__name`, which the page lacks.
      const named = globalThis as typeof globalThis & { __name?: (fn: unknown) => unknown };
      named.__name ??= (fn) => fn;
      const declared = () => [document.documentElement, document.body].some(
        (element) => element?.classList.contains('loading') || element?.getAttribute('aria-busy') === 'true'
      );
      // Walk the composed tree: an open shadow host (a consent or chat widget)
      // is retargeted by hit testing, while its fixed box lives inside.
      const composedParent = (element: Element): Element | null =>
        element.parentElement ?? ((element.getRootNode() as ShadowRoot).host ?? null);
      const fixedRoot = (element: Element, x: number, y: number): Element | null => {
        let current: Element | null = element;
        for (let inner = current.shadowRoot?.elementFromPoint(x, y); inner && inner !== current; inner = current.shadowRoot?.elementFromPoint(x, y)) current = inner;
        for (; current && current !== document.body && current !== document.documentElement; current = composedParent(current))
          if (getComputedStyle(current).position === 'fixed') return current;
        return null;
      };
      const spansViewport = (element: Element) => {
        const box = element.getBoundingClientRect();
        return box.left <= 0 && box.top <= 0 && box.right >= innerWidth && box.bottom >= innerHeight &&
          !(element as HTMLElement).innerText?.trim();
      };
      // At every sampled point, the first thing the visitor reaches below any
      // small fixed widgets (a floating chat or privacy button) is the same
      // textless viewport-spanning fixed layer, not page content.
      const covered = () => {
        let layer: Element | null = null;
        for (const [fx, fy] of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
          const x = innerWidth * fx, y = innerHeight * fy;
          let reached: Element | null = null;
          for (const hit of document.elementsFromPoint(x, y)) {
            const root = fixedRoot(hit, x, y);
            if (!root) return false;
            if (spansViewport(root)) { reached = root; break; }
          }
          if (!reached || (layer && reached !== layer)) return false;
          layer = reached;
        }
        return layer !== null;
      };
      const busy = () => declared() || covered();
      if (!busy()) return false;
      return new Promise<boolean>((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
          if (!busy() || Date.now() >= deadline) resolve(true);
          else setTimeout(poll, 100);
        };
        poll();
      });
    }, { timeoutMs }), timeoutMs + 1_000);
    if (wasBusy) await settleDocument(page, 'declared-loading', { quietMs: 500, timeoutMs: 2_000 });
  } catch {
    /* best-effort — never hang a capture on an orphaned loading state */
  }
}


/**
 * Settle the declared stacks of painted text, not only the faces layout chose.
 * fonts.ready alone leaves unused @font-face fallbacks unloaded, while the
 * observation's fonts.check asks about the whole computed stack. Explicitly
 * load those stacks so a usable local fallback is not mistaken for a failure.
 * Re-read computed styles on every call (including after viewport changes).
 * Failed/pending faces remain detectable by fonts.check; this best-effort wait
 * does not decide readiness or let a blocked font hang capture.
 */
export async function waitForFonts(page: Page, timeoutMs: number = 4_000): Promise<void> {
  try {
    await withEvaluateTimeout(
      page.evaluate(async (budget) => {
        const deadline = Date.now() + budget;
        const stacks = new Map<string, Set<string>>();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while (Date.now() < deadline && (node = walker.nextNode())) {
          const parent = node.parentElement;
          const text = node.textContent?.replace(/\s+/g, ' ').trim();
          if (!parent || !text || parent.closest('script,style,noscript,template')) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          const style = getComputedStyle(parent);
          if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
          const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const characters = stacks.get(font) ?? new Set<string>();
          for (const character of text) characters.add(character);
          stacks.set(font, characters);
        }
        // One load per stack with all observed codepoints preserves unicode-range
        // matching without issuing a separate load for every repeated text node.
        const loading = Promise.all([...stacks].map(([font, characters]) =>
          document.fonts.load(font, [...characters].join('')).catch(() => undefined)
        )).then(() => document.fonts.ready);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            loading,
            new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
          ]);
        } finally { clearTimeout(timer); }
        return true;
      }, timeoutMs),
      timeoutMs + 1_000,
    );
  } catch {
    /* best-effort — never block capture on a slow/blocked webfont */
  }
}

const UNREACHABLE_LAZY_IMAGE = 'data-liberation.unreachable-lazy-image';

/**
 * Install the page's `unreachableLazyImage( image )` readiness predicate and
 * return its global symbol key.
 *
 * A pending native-lazy image whose box lies outside an ancestor's overflow
 * clip (an image beyond the visible part of a horizontal rail, for example) is
 * never fetched by a vertical document sweep. It therefore cannot change the
 * geometry being waited for, and waiting on it can only spend the deadline.
 * Images the sweep can reach still gate readiness, and revealing one later
 * changes its intersection, so it gates the next wait again.
 *
 * Installed through `evaluate` rather than rebuilt from source so pages whose
 * CSP forbids `eval` still get the same single definition.
 */
export async function installImageReachability(page: Page): Promise<string> {
  await withEvaluateTimeout(page.evaluate((key) => {
    const symbol = Symbol.for(key);
    if (symbol in window) return;
    Object.defineProperty(window, symbol, {
      configurable: true,
      value: (image: HTMLImageElement): boolean => {
        if (image.complete || image.loading !== 'lazy') return false;
        const box = image.getBoundingClientRect();
        for (let node = image.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
          const clip = node.getBoundingClientRect();
          if (box.right <= clip.left || box.left >= clip.right || box.bottom <= clip.top || box.top >= clip.bottom) return true;
        }
        return false;
      },
    });
  }, UNREACHABLE_LAZY_IMAGE), EVALUATE_GRACE_MS);
  return UNREACHABLE_LAZY_IMAGE;
}

/**
 * Wait for images reached by the lazy-load sweep to decode before measuring.
 * Image load can complete before layout has incorporated the decoded intrinsic
 * size, so waiting for the request alone is not enough for responsive pages.
 *
 * Inactive alternatives without layout boxes need not delay this viewport.
 * Visibility-hidden layout participants still settle; resource localization
 * remains independent of rendering readiness.
 */
export async function waitForImages(page: Page, timeoutMs: number = 4_000): Promise<void> {
  try {
    const reachabilityKey = await installImageReachability(page);
    await withEvaluateTimeout(
      page.evaluate(async (reachabilityKey) => {
        const unreachable = (window as unknown as Record<symbol, (image: HTMLImageElement) => boolean>)[Symbol.for(reachabilityKey)];
        const active = (image: HTMLImageElement): boolean => {
          if (unreachable(image)) return false;
          if (image.checkVisibility()) return true;
          const box = image.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        };
        const images = [ ...document.images ].filter(active);
        await Promise.all(
          images.map(async (image) => {
            if (!image.complete) {
              await new Promise<void>((resolve) => {
                image.addEventListener('load', () => resolve(), { once: true });
                image.addEventListener('error', () => resolve(), { once: true });
                if (image.complete) resolve();
              });
            }
            await image.decode().catch(() => undefined);
          })
        );
      }, reachabilityKey),
      timeoutMs,
    );
  } catch {
    /* best-effort — never block capture on a slow/blocked image */
  }
}


const RENDER_RESOURCE_TYPES = new Set( [ 'script', 'stylesheet', 'font', 'image', 'media' ] );

function requestAffectsRenderedContent( page: Page, request: Request ): boolean {
  const resourceType = request.resourceType();
  if ( RENDER_RESOURCE_TYPES.has( resourceType ) ) return true;
  if ( ! [ 'fetch', 'xhr' ].includes( resourceType ) ) return false;
  try {
    return new URL( request.url() ).origin === new URL( page.url() ).origin;
  } catch {
    return false;
  }
}

/** Run lazy-load work and wait until render-affecting requests become quiet. */
export async function waitForRenderIdle(
  page: Page,
  action: () => Promise< unknown >,
  quietMs: number = 500,
  timeoutMs: number = 5_000,
): Promise<void> {
  if ( ! page.on || ! page.off ) {
    await action();
    try {
      await page.waitForLoadState( 'networkidle', { timeout: timeoutMs } );
    } catch {
      /* best-effort fallback for reduced browser implementations */
    }
    return;
  }

  const active = new Set< Request >();
  let lastActivity = Date.now();
  const onRequest = ( request: Request ) => {
    if ( ! requestAffectsRenderedContent( page, request ) ) return;
    active.add( request );
    lastActivity = Date.now();
  };
  const onFinished = ( request: Request ) => {
    if ( ! active.delete( request ) ) return;
    lastActivity = Date.now();
  };
  page.on( 'request', onRequest );
  page.on( 'requestfinished', onFinished );
  page.on( 'requestfailed', onFinished );

  try {
    await action();
    const waitStarted = Date.now();
    await new Promise< void >( ( resolve ) => {
      const check = () => {
        const now = Date.now();
        if (
          now - waitStarted >= timeoutMs ||
          ( active.size === 0 && now - lastActivity >= quietMs )
        ) {
          resolve();
          return;
        }
        setTimeout( check, Math.min( 50, timeoutMs - ( now - waitStarted ) ) );
      };
      check();
    } );
  } finally {
    page.off( 'request', onRequest );
    page.off( 'requestfinished', onFinished );
    page.off( 'requestfailed', onFinished );
  }
}

/** Whether the document has physical overflow in either viewport dimension. */
export async function documentCanScroll(page: Page): Promise<boolean> {
  try {
    const canScroll = await withEvaluateTimeout(page.evaluate(() =>
      document.documentElement.scrollHeight > window.innerHeight ||
      document.documentElement.scrollWidth > window.innerWidth
    ), EVALUATE_GRACE_MS);
    return typeof canScroll === 'boolean' ? canScroll : true;
  } catch {
    // When the document cannot be inspected, preserve scroll-dependent waits.
    return true;
  }
}

/**
 * Scroll from top to bottom in 500px increments with 200ms between steps,
 * repeating the sweep until the page stops growing, wait for render-affecting
 * requests to become quiet, then RESTORE the top scroll state and let the
 * resulting transitions settle. Triggers lazy-loaded images so the subsequent
 * screenshot captures actual content instead of placeholders.
 *
 * Restoring the top state matters for scroll-reactive sticky headers: the
 * scroll-through above fades/hides them, and a bare `scrollTo(0, 0)` does NOT
 * un-hide them — the builder's scroll handler only recomputes the at-top state
 * on a real scroll EVENT. So we scroll to top AND dispatch a `scroll` event,
 * then [[settleDocument]] for the restore (and any viewport-entry reveals) to
 * finish. Without this the header is captured faded — the root cause of "blank"
 * Wix nav captures (verified: header section opacity 1 at load → 0 after a bare
 * lazy scroll → back to 1 after scrollTo(0,0)+scroll-event).
 *
 * EVERY scrollTo here is explicit-instant (`behavior: 'instant'` overrides css
 * `html{scroll-behavior:smooth}` per spec). A smooth-scroll site turns a bare
 * scrollTo into a GLIDE that races the capture: the walrus probe measured the
 * restore at scrollY 4 with the is-scrolled header still compressed (h:52)
 * 400ms after scrollTo(0,0)+dispatch — the glide finished DURING the
 * screenshot (after-snap: y 0, h:84), so scroll-reactive chrome captured
 * nondeterministically (32 css px header ghost on the replica side).
 *
 * The sweep re-reads `scrollHeight` on every step rather than sampling it once
 * up front. A page with `loading="lazy"` images or an IntersectionObserver
 * reveal (fade/slide-in sections) GROWS as the sweep passes it — a height
 * sampled before the first step is stale by the last one, so a single pass to
 * a fixed target leaves the newly-added tail off-screen, its reveal never
 * fires, and it serializes in whatever hidden/placeholder state it started in.
 * Worse, that tail differs run to run with exactly when the growth lands
 * relative to the steps, so the SAME document produced a different reveal
 * count on different runs. Reaching the bottom is also not enough on its own:
 * `waitForImages` below can decode an image that is itself what a reveal
 * observer at the tail was waiting on, growing the page again with nothing
 * left to scroll it into view. `settleScroll` alternates a sweep with an image
 * wait and repeats until a round changes nothing, bounded by round count and
 * wall-clock time so a page that grows forever (true infinite scroll) still
 * terminates rather than capturing forever.
 */
export async function triggerLazyLoad(page: Page, requireNetworkIdle: boolean = false, options: { expandContent?: boolean } = {}): Promise<void> {
  try {
    const canScroll = await documentCanScroll(page);
    // One page.evaluate call per sweep, given the time it's still allowed to
    // run: `maxMs` here is the REMAINING settle budget, not a fixed per-sweep
    // allowance, so a page that never stops growing can't spend the full
    // per-sweep cap on every one of `settleScroll`'s rounds and blow past the
    // overall budget by a multiple of it.
    // Every in-page step is also bounded from Node: a renderer whose main
    // thread is spinning never answers, so its own budget never fires.
    const sweepToBottom = (maxMs: number) =>
      withEvaluateTimeout(page.evaluate(
        async ({ step, pauseMs, maxMs }) => {
          const started = Date.now();
          let y = window.scrollY;
          let total = document.documentElement.scrollHeight;
          // The viewport already covers the final innerHeight pixels. Walking
          // toward scrollHeight overscrolls a clamped page and sleeps despite
          // revealing nothing, again on every image-settling round.
          let bottom = Math.max(0, total - window.innerHeight);
          while (y < bottom && Date.now() - started < maxMs) {
            // A step taller than the layout viewport (a phone document scaled
            // into a wide window) jumps over content that never intersects, so
            // its viewport-gated loads and entrances never run.
            y = Math.min(y + Math.max(1, Math.min(step, window.innerHeight)), bottom);
            window.scrollTo({ top: y, left: 0, behavior: 'instant' });
            await new Promise((r) => setTimeout(r, pauseMs));
            total = document.documentElement.scrollHeight;
            bottom = Math.max(0, total - window.innerHeight);
          }
          return total;
        },
        { step: 500, pauseMs: 200, maxMs },
      ), maxMs + EVALUATE_GRACE_MS);
    const settleScroll = async () => {
      const deadline = Date.now() + 20_000;
      let previousHeight = -1;
      for (let round = 0; round < 10; round++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const height = await sweepToBottom(remaining);
        await waitForImages(page);
        if (height === previousHeight) break;
        previousHeight = height;
      }
    };
    if ( requireNetworkIdle ) {
      if ( canScroll ) await settleScroll();
      try {
        await page.waitForLoadState( 'networkidle', { timeout: 5_000 } );
      } catch {
        /* best-effort hydration window for the responsive geometry sweep */
      }
    } else {
      if ( canScroll ) await waitForRenderIdle(page, settleScroll);
    }
    // Dynamic / JS-app content: expand statically-collapsed sections, then wait for known
    // content widgets (reviews / FAQ apps) to populate — so the snapshot captures real
    // content, not an empty placeholder. Both are no-ops on ordinary pages. (See
    // dynamic-content.ts; DISCOVERIES 2026-06-04.)
    if (options.expandContent !== false) await withEvaluateTimeout(expandCollapsedContent(page), 30_000);
    await withEvaluateTimeout(waitForAppWidgets(page), 8_000 + EVALUATE_GRACE_MS);
    await waitForImages(page);
  } catch (error) {
    /* if the page crashes or blocks our script, don't fail the capture */
    // A renderer that stopped answering will not answer the restore either;
    // callers that measure check the pose themselves.
    if (error instanceof Error && error.message.startsWith('evaluate timeout')) return;
  }
  // The sweep moved the document, so it owes the top pose back even when a
  // step above was interrupted: callers measure and serialize right after
  // this, and a skipped restore left them describing the page parked
  // mid-sweep or at the bottom. Fire a scroll event so scroll-reactive
  // headers recompute their at-top state — scrollTo alone doesn't trigger it.
  try {
    await restoreTopScrollState(page);
  } catch {
    /* an unresponsive page is reported by the caller's pose check */
  }
}

/** Restore the same top-of-document state used by baseline artifacts and probes. */
export async function restoreTopScrollState(page: Page): Promise<void> {
  const canScroll = await documentCanScroll(page);
  await withEvaluateTimeout(page.evaluate(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    window.dispatchEvent(new Event('scroll'));
  }), EVALUATE_GRACE_MS);
  // Throttled scroll handlers react within a quiet window after the event;
  // the transitions they start are then settled. A document that cannot
  // scroll gave its handlers nothing new to react to.
  await settleDocument(page, 'scroll-restore', { quietMs: canScroll ? 200 : 0, timeoutMs: 2_000, animations: true });
  await waitForFonts(page);
}

/**
 * Whether the page's main thread still answers a trivial evaluate. A renderer
 * stuck in a script loop never does, and every later step would hang with it.
 */
export async function pageResponds(page: Page, ms: number = EVALUATE_GRACE_MS): Promise<boolean> {
  try {
    await withEvaluateTimeout(page.evaluate(() => true), ms);
    return true;
  } catch {
    return false;
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
  textShare?: number;        // share of the document's rendered text inside it, 0..1
  isLandmark?: boolean;      // semantic site chrome must not be dismissed as a nested overlay
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
  kind: 'takeover' | 'consent' | 'provider-promotion';
  score: number;
  signals: string[];
  selector: string;
  hasCloseAffordance: boolean;
}

// DismissedOverlay and DismissOverlaysOpts are forward-declared here; they are
// consumed by the dismissOverlays orchestrator added in a later task.

/** A record of one overlay we dismissed (returned + logged for observability). */
export interface DismissedOverlay {
  selector: string;
  method: 'close-click' | 'escape' | 'remove';
  kind: 'takeover' | 'consent' | 'provider-promotion';
  score: number;
  signals: string[];
}

export interface DismissOverlaysOpts {
  /** Max detect→dismiss rounds (stacked overlays). Default 3. */
  maxRounds?: number;
  /**
   * Which kinds to dismiss. Default: all of them, which is what capture wants.
   * A caller that measures source attribution separately narrows this so the
   * two mechanisms do not consume each other's evidence.
   */
  kinds?: ReadonlyArray<OverlayTarget['kind']>;
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

const CONSENT_TEXT_RE = /\bcookies?\b|\bconsent\b|\bgdpr\b|\bccpa\b|\baccept all\b|privacy (policy|preferences)/i;
const CONSENT_VENDOR_RE = /onetrust|cookiebot|usercentrics|termly|osano|trustarc|cookieyes/i;

/**
 * A looser, separate classifier for cookie/consent banners. They frequently do
 * NOT lock scroll and are thin strips, so they won't clear the takeover score;
 * we flag them by consent keywords / known vendors in their text/aria/selector.
 */
export function isConsentBanner(c: OverlayCandidate): boolean {
  const hay = `${c.text} ${c.ariaLabel ?? ''} ${c.selector}`;
  return CONSENT_TEXT_RE.test(hay) || CONSENT_VENDOR_RE.test(hay);
}

/** Hosting-platform acquisition chrome is not authored site content. */
export function isProviderPromotion(c: OverlayCandidate): boolean {
  const hay = `${c.text} ${c.ariaLabel ?? ''} ${c.selector}`;
  return c.coverageRatio < 0.25 && isSourcePromotion(hay);
}

/** A candidate holding at least this share of the document's text is the page itself. */
const PAGE_TEXT_SHARE = 0.9;

/**
 * Decide which candidates are overlays and in what order to dismiss them.
 * Pure. Takeovers (score ≥ threshold) first, highest score first; then consent
 * banners that did not already qualify as takeovers. Benign chrome is dropped.
 */
export function selectOverlayTargets(d: OverlayDetection): OverlayTarget[] {
  const takeovers: OverlayTarget[] = [];
  const consents: OverlayTarget[] = [];
  const providerPromotions: OverlayTarget[] = [];
  // `?? []` keeps this pure fn total: a partial detection result can't throw
  // (lets the mocked-browser path be a true no-op, and removes a hidden
  // dependency on dismissOverlays' try/catch).
  for (const c of d.candidates ?? []) {
    // Nothing is behind a layer that holds the document's text: it is the page
    // (a password or access gate, say), and removing it leaves an empty document.
    if ((c.textShare ?? 0) >= PAGE_TEXT_SHARE) continue;
    const { score, signals } = scoreOverlay(c, d.scrollLock);
    // Ambient signals alone (page-global scroll-lock + a SIBLING modal's backdrop)
    // can lift benign sticky chrome to the threshold. Require a takeover to either
    // carry its own modal semantics (aria-modal / role=dialog) OR cover a real slice
    // of the viewport — so a small age-gate dialog is still caught while a thin
    // sticky header (no modal role, tiny coverage) is not.
    const hasModalRole = c.ariaModal || c.role === 'dialog' || c.role === 'alertdialog';
    // Consent banners are sometimes rendered inside a site's semantic header.
    // Its combined text then contains the cookie copy, but removing the header
    // also removes the site's logo and navigation. Leave implicit overlay
    // classifications to positioned descendants; explicit dialog semantics
    // still allow a genuine modal landmark to be handled.
    if (c.isLandmark && !hasModalRole) continue;
    // A close control can be an ordinary header/menu descendant (Squarespace
    // headers commonly contain a mobile menu toggle). It is useful after an
    // overlay has been identified, but by itself must not turn the global
    // scroll-lock signal into evidence that this candidate is a takeover.
    const hasOverlayEvidence =
      hasModalRole || c.vendorHint || (c.hasCloseAffordance && c.coverageRatio >= 0.15) ||
      (c.hasBackdrop && c.coverageRatio >= 0.15);
    if (score >= OVERLAY_THRESHOLD && hasOverlayEvidence) {
      takeovers.push({
        idx: c.idx, kind: 'takeover', score, signals,
        selector: c.selector, hasCloseAffordance: c.hasCloseAffordance,
      });
    } else if (isConsentBanner(c)) {
      consents.push({
        idx: c.idx, kind: 'consent', score, signals: [...signals, 'consent'],
        selector: c.selector, hasCloseAffordance: c.hasCloseAffordance,
      });
    } else if (isProviderPromotion(c)) {
      providerPromotions.push({
        idx: c.idx, kind: 'provider-promotion', score, signals: [...signals, 'provider-promotion'],
        selector: c.selector, hasCloseAffordance: c.hasCloseAffordance,
      });
    }
  }
  takeovers.sort((a, b) => b.score - a.score);
  return [...takeovers, ...consents, ...providerPromotions];
}

/**
 * Measure all fixed/sticky candidates in the page, stamp each with
 * data-lib-overlay="<idx>" (and its close control with data-lib-overlay-close)
 * so Node can target them, and return descriptors + the page scroll-lock state.
 */
function detectOverlays(page: Page): Promise<OverlayDetection> {
  return page.evaluate(() => {
    const globalWithName = globalThis as typeof globalThis & { __name?: (fn: unknown) => unknown };
    if (typeof globalWithName.__name === 'undefined') globalWithName.__name = (fn) => fn;
    const VENDOR = /klaviyo|privy|optinmonster|justuno|sumo|mailchimp|popup|newsletter|subscribe|interstitial/i;
    const SCROLL_LOCK = /(prevent|disable|no)[-_]?(body[-_]?)?scroll|modal[-_]?open|scroll[-_]?lock/i;
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const vpArea = vw * vh || 1;
    const cls = (el: Element) => (typeof el.className === 'string' ? el.className : '');
    const visible = (cs: CSSStyleDeclaration) =>
      cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.1;

    const lockActive = [document.body, document.documentElement].some((el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'hidden' || cs.overflow === 'clip' ||
          cs.overflowY === 'hidden' || cs.overflowY === 'clip') return true;
      return SCROLL_LOCK.test(cls(el));
    });

    const cssPath = (el: Element) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const c = cls(el).trim() ? '.' + cls(el).trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${tag}${id}${c}`;
    };

    const CLOSE_SEL =
      '[aria-label*="close" i],[title*="close" i],button[class*="close" i],[data-dismiss],[data-testid*="close" i]';
    const findClose = (el: Element): Element | null => {
      const explicit = el.querySelector(CLOSE_SEL);
      if (explicit) return explicit;
      const btns = Array.from(el.querySelectorAll('button,a,[role="button"]'));
      return btns.find((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        return t === '×' || t === '✕' || t === 'x' || t === 'close';
      }) || null;
    };

    const hasBackdrop = (el: Element): boolean => {
      const sibs = el.parentElement ? Array.from(el.parentElement.children) : [];
      return sibs.some((s) => {
        if (s === el) return false;
        const cs = getComputedStyle(s);
        if (cs.position !== 'fixed') return false;
        const r = s.getBoundingClientRect();
        const cover = (r.width * r.height) / vpArea;
        const op = parseFloat(cs.opacity || '1');
        const bg = cs.backgroundColor || '';
        return cover >= 0.9 && (op < 1 || /rgba?\([^)]*0?\.\d+\s*\)/.test(bg));
      });
    };

    const pageTextLength = (document.body?.innerText || '').trim().length;
    const candidates: Array<Record<string, unknown>> = [];
    let idx = 0;
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      if ((cs.position !== 'fixed' && cs.position !== 'sticky') || !visible(cs)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.1 && r.height < vh * 0.1) continue; // drop trackers/badges
      el.setAttribute('data-lib-overlay', String(idx));
      const close = findClose(el);
      if (close) close.setAttribute('data-lib-overlay-close', String(idx));
      candidates.push({
        idx,
        selector: cssPath(el),
        role: el.getAttribute('role'),
        ariaModal: el.getAttribute('aria-modal') === 'true',
        zIndex: parseInt(cs.zIndex, 10) || 0,
        coverageRatio: Math.min(1, (r.width * r.height) / vpArea),
        hasBackdrop: hasBackdrop(el),
        vendorHint: VENDOR.test(`${el.id} ${cls(el)}`),
        text: (el.textContent || '').toLowerCase().slice(0, 400),
        ariaLabel: ((el.getAttribute('aria-label') || '').toLowerCase()) || null,
        hasCloseAffordance: !!close,
        isLandmark: /^(HEADER|NAV)$/.test(el.tagName) ||
          ['banner', 'navigation', 'contentinfo'].includes((el.getAttribute('role') || '').toLowerCase()),
        textShare: pageTextLength
          ? ((el as HTMLElement).innerText || '').trim().length / pageTextLength
          : 0,
      });
      idx++;
    }
    // Some platforms (including Squarespace) put their cookie notice in normal
    // flow inside a fixed semantic header. The header is overlay-positioned,
    // but the notice itself is static, so the positioned-element scan above
    // cannot safely target it. Add only explicitly labelled/identified consent
    // descendants with a real action control; selection still uses the shared
    // consent classifier and dismissal policy.
    const consentHint = /cookie|consent|gdpr/i;
    for (const el of Array.from(document.querySelectorAll('[aria-label],[class]'))) {
      if (el.hasAttribute('data-lib-overlay')) continue;
      const identity = `${el.getAttribute('aria-label') || ''} ${cls(el)}`;
      if (!consentHint.test(identity) || !el.querySelector('button,[role="button"],input[type="button"],input[type="submit"]')) continue;
      let positionedHost = el.parentElement;
      while (positionedHost && !['fixed', 'sticky'].includes(getComputedStyle(positionedHost).position)) {
        positionedHost = positionedHost.parentElement;
      }
      if (!positionedHost) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!visible(cs) || r.width < vw * 0.1 || r.height < 24 || r.height > vh * 0.5) continue;
      el.setAttribute('data-lib-overlay', String(idx));
      const close = findClose(el);
      if (close) close.setAttribute('data-lib-overlay-close', String(idx));
      candidates.push({
        idx,
        selector: cssPath(el),
        role: el.getAttribute('role'),
        ariaModal: el.getAttribute('aria-modal') === 'true',
        zIndex: parseInt(cs.zIndex, 10) || 0,
        coverageRatio: Math.min(1, (r.width * r.height) / vpArea),
        hasBackdrop: hasBackdrop(el),
        vendorHint: VENDOR.test(`${el.id} ${cls(el)}`),
        text: (el.textContent || '').toLowerCase().slice(0, 400),
        ariaLabel: ((el.getAttribute('aria-label') || '').toLowerCase()) || null,
        hasCloseAffordance: !!close,
        isLandmark: /^(HEADER|NAV)$/.test(el.tagName) ||
          ['banner', 'navigation', 'contentinfo'].includes((el.getAttribute('role') || '').toLowerCase()),
        textShare: pageTextLength
          ? ((el as HTMLElement).innerText || '').trim().length / pageTextLength
          : 0,
      });
      idx++;
    }
    const consentVendor = /onetrust|cookiebot|usercentrics|termly|osano|trustarc|cookieyes/i;
    for (const host of Array.from(document.querySelectorAll('*'))) {
      if (!host.shadowRoot || host.hasAttribute('data-lib-overlay')) continue;
      if (!consentVendor.test(`${host.id} ${cls(host)}`)) continue;
      const action = Array.from(host.shadowRoot.querySelectorAll('button,[role="button"]')).find((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (!action) continue;
      host.setAttribute('data-lib-overlay', String(idx));
      candidates.push({
        idx,
        selector: cssPath(host),
        role: host.getAttribute('role'),
        ariaModal: false,
        zIndex: parseInt(getComputedStyle(host).zIndex, 10) || 0,
        coverageRatio: 0.2,
        hasBackdrop: false,
        vendorHint: true,
        text: (host.shadowRoot.textContent || '').toLowerCase().slice(0, 400),
        ariaLabel: null,
        hasCloseAffordance: false,
        isLandmark: false,
        textShare: 0,
      });
      idx++;
    }
    return { candidates, scrollLock: { active: lockActive } } as unknown as OverlayDetection;
  });
}

/** Is the stamped overlay still present + visible? */
function overlayPresent(page: Page, idx: number): Promise<boolean> {
  return page.evaluate((i: number) => {
    const el = document.querySelector(`[data-lib-overlay="${i}"]`);
    if (!el) return false;
    const shown = (node: Element) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.1;
    };
    if (el.shadowRoot) {
      const viewport = (window.innerWidth || 1) * (window.innerHeight || 1) || 1;
      return Array.from(el.shadowRoot.querySelectorAll('*')).some((node) => {
        if (!shown(node)) return false;
        const rect = node.getBoundingClientRect();
        return (rect.width * rect.height) / viewport >= 0.12;
      });
    }
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.1;
  }, idx);
}

/** If body/html scroll is still locked, force-unlock it (best-effort). */
function ensureScrollUnlocked(page: Page): Promise<void> {
  return page.evaluate(() => {
    const SCROLL_LOCK = /(prevent|disable|no)[-_]?(body[-_]?)?scroll|modal[-_]?open|scroll[-_]?lock/i;
    const isLocked = (el: HTMLElement) => {
      const cs = getComputedStyle(el);
      return cs.overflow === 'hidden' || cs.overflow === 'clip' ||
             cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    };
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      (el as HTMLElement).style.overflow = '';
      // Strip only KNOWN single-purpose scroll-lock classes (safe to remove).
      if (typeof el.className === 'string') {
        el.className = el.className.split(/\s+/).filter((c) => c && !SCROLL_LOCK.test(c)).join(' ');
      }
      // If a lock survives (inline !important, or an unrecognized lock class), force it
      // open via an important inline override rather than brute-force-removing site
      // classes — removing a class that also drives styling would corrupt carried HTML.
      if (isLocked(el as HTMLElement)) {
        (el as HTMLElement).style.setProperty('overflow', 'visible', 'important');
      }
    }
  });
}

/** Remove every detection stamp so the captured HTML is clean. */
function cleanupStamps(page: Page): Promise<void> {
  return page.evaluate(() => {
    for (const a of ['data-lib-overlay', 'data-lib-overlay-close', 'data-lib-overlay-consent']) {
      for (const el of Array.from(document.querySelectorAll(`[${a}]`))) el.removeAttribute(a);
    }
  });
}

/**
 * Last resort: remove the stamped overlay, and (for takeovers only) a
 * full-viewport sibling backdrop. Scroll-unlock is NOT done here — the
 * orchestrator calls ensureScrollUnlocked after any round that acted (a
 * successful force-remove always sets a method), so duplicating the unlock
 * probe here would be redundant.
 *
 * `removeBackdrop` is gated to takeover modals: a consent strip reaching Tier 3
 * could share a parent with a real full-viewport fixed element (hero bg / app
 * shell), and deleting that would corrupt the carried page.
 */
function forceRemoveOverlay(page: Page, idx: number, removeBackdrop: boolean, reclaimBottomSpace: boolean): Promise<void> {
  return page.evaluate(({ i, removeBackdrop, reclaimBottomSpace }: { i: number; removeBackdrop: boolean; reclaimBottomSpace: boolean }) => {
    const el = document.querySelector(`[data-lib-overlay="${i}"]`);
    if (el) {
      const reservedHeight = el.getBoundingClientRect().height;
      if (removeBackdrop) {
        const vpArea = (window.innerWidth || 1) * (window.innerHeight || 1) || 1;
        const parent = el.parentElement;
        if (parent) {
          for (const s of Array.from(parent.children)) {
            if (s === el) continue;
            const cs = getComputedStyle(s);
            const r = s.getBoundingClientRect();
            if (cs.position === 'fixed' && (r.width * r.height) / vpArea >= 0.9) s.remove();
          }
        }
      }
      el.remove();
      if (reclaimBottomSpace && document.body.style.paddingBottom && Math.abs(parseFloat(getComputedStyle(document.body).paddingBottom) - reservedHeight) < 1) {
        document.body.style.removeProperty('padding-bottom');
      }
    }
  }, { i: idx, removeBackdrop, reclaimBottomSpace });
}

/**
 * Click a consent banner's accept/reject control (preferring reject/decline).
 * Stamps the chosen control so Node can issue a real, trusted click. Returns
 * whether a control was found + clicked.
 */
async function clickConsentControl(page: Page, idx: number): Promise<boolean> {
  const found = await page.evaluate((i: number) => {
    const root = document.querySelector(`[data-lib-overlay="${i}"]`);
    if (!root) return false;
    const ACCEPT = /^(reject|decline|deny|accept|agree|got it|allow|ok)\b/i;
    const ctrls = Array.from((root.shadowRoot || root).querySelectorAll('button,a,[role="button"]'));
    const prefer = ctrls.find((b) => /^(reject|decline|deny)\b/i.test((b.textContent || '').trim()));
    const chosen = prefer || ctrls.find((b) => ACCEPT.test((b.textContent || '').trim()));
    if (!chosen) return false;
    chosen.setAttribute('data-lib-overlay-consent', String(i));
    return true;
  }, idx);
  if (!found) return false;
  try {
    const host = page.locator(`[data-lib-overlay="${idx}"]`);
    const reject = host.getByRole('button', { name: /^(deny|reject|decline)\b/i });
    const accept = host.getByRole('button', { name: /^(accept all|accept|agree|allow|got it|ok)\b/i });
    if (await reject.count()) await reject.first().click({ timeout: 1500 });
    else if (await accept.count()) await accept.first().click({ timeout: 1500 });
    else await host.locator('[data-lib-overlay-consent]').click({ timeout: 1500 });
    if (await overlayPresent(page, idx) && await accept.count()) await accept.first().click({ timeout: 1500 });
    for (let attempt = 0; attempt < 15; attempt++) {
      if (!(await overlayPresent(page, idx))) return true;
      await page.waitForTimeout(100);
    }
    return !(await overlayPresent(page, idx));
  } catch {
    return false;
  }
}

/** Attempt to dismiss one target; returns the method that worked, or null. */
async function dismissOne(
  page: Page,
  t: OverlayTarget,
): Promise<DismissedOverlay['method'] | null> {
  // Skip if already gone (e.g. removed by a sibling's close handler).
  if (!(await overlayPresent(page, t.idx))) return null;
  // Consent banners: their accept/reject control IS the dismissal (and rarely a
  // close ×), so try it before the generic close affordance.
  if (t.kind === 'consent') {
    if (await clickConsentControl(page, t.idx)) {
      if (!(await overlayPresent(page, t.idx))) return 'close-click';
    }
  }
  // Tier 1 — graceful close: a real click fires the site's handler, which
  // releases its own scroll-lock.
  if (t.hasCloseAffordance) {
    try {
      await page.click(`[data-lib-overlay-close="${t.idx}"]`, { timeout: 1500 });
      if (!(await overlayPresent(page, t.idx))) return 'close-click';
    } catch {
      /* fall through to the next tier */
    }
  }
  // Tier 2 — Escape (many modal libraries close on it).
  try {
    await page.keyboard.press('Escape');
    if (!(await overlayPresent(page, t.idx))) return 'escape';
  } catch {
    /* fall through to the next tier */
  }
  // Tier 3 — force remove + unlock (last resort). Backdrop removal is gated to
  // takeovers: a consent strip could share a parent with a real full-screen
  // fixed element we must not delete.
  try {
  await forceRemoveOverlay(page, t.idx, t.kind === 'takeover', t.kind === 'provider-promotion');
    if (!(await overlayPresent(page, t.idx))) return 'remove';
  } catch {
    /* give up on this overlay */
  }
  return null;
}

/**
 * Best-effort: detect and dismiss takeover modals + consent banners before
 * capture. NEVER throws — a dismissal failure must not fail a capture. Bounded
 * by maxRounds; re-detects each round to clear stacked/late overlays.
 */
export async function dismissOverlays(
  page: Page,
  opts: DismissOverlaysOpts = {},
): Promise<DismissedOverlay[]> {
  const maxRounds = opts.maxRounds ?? 3;
  const dismissed: DismissedOverlay[] = [];
  try {
    for (let round = 0; round < maxRounds; round++) {
      const detection = await withEvaluateTimeout(detectOverlays(page), 4000);
      const kinds = opts.kinds;
      const targets = selectOverlayTargets(detection).filter((t) => !kinds || kinds.includes(t.kind));
      if (targets.length === 0) break;
      let acted = 0;
      for (const t of targets) {
        const method = await withEvaluateTimeout(dismissOne(page, t), 10_000);
        if (method) {
          dismissed.push({ selector: t.selector, method, kind: t.kind, score: t.score, signals: t.signals });
          acted++;
        }
      }
      if (acted > 0) await withEvaluateTimeout(ensureScrollUnlocked(page), EVALUATE_GRACE_MS);
      await withEvaluateTimeout(cleanupStamps(page), EVALUATE_GRACE_MS);
      if (acted === 0) break; // nothing dismissable left; stop early
    }
  } catch {
    /* best-effort — never fail a capture on overlay dismissal */
  } finally {
    try { await withEvaluateTimeout(cleanupStamps(page), EVALUATE_GRACE_MS); } catch { /* ignore */ }
  }
  return dismissed;
}
