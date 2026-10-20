// src/adapters/page-actions.ts
import type { Page } from 'playwright';

/** Platform-specific preparation applied while liberating a live page. */
export interface LiberationHooks {
  /** Additional source identities, selected from the acquired primary document.
   * No profile may alias a document captured under another request identity. */
  additionalProfiles?(desktopHtml: string): readonly import('../lib/screenshot/capture-profiles.js').CaptureProfile[];
  /** Explicit acceptance ladder for device-dependent sources. Ordinary sources
   * keep the default desktop 768/1440 and phone 390 cells. */
  referenceWidths?: number[];
  /** Source-owned selection, declared only when captured identities support it.
   * Geometry floors and unrelated CSS breakpoints are not document selection. */
  documentSelection?(documents: Readonly<Record<string, string>>): import('../lib/document-selection.js').DocumentSelection | undefined;
  /** Recognize an observed client-side navigation as a source-declared alias.
   * Return only a same-origin target; uncertainty leaves the route to normal capture. */
  resolveClientRedirect?(page: Page, url: string): Promise<string | undefined>;
  /** Source branding rules shared by capture and comparison. */
  cleanupRules?: import('../lib/source-cleanup.js').CleanupRule[];
  /**
   * Recognize a request URL as this platform's own telemetry: an endpoint whose
   * response never reaches the rendered document. Readiness waits then do not
   * hold for it while it is pending. Declare only endpoints known to be
   * telemetry; anything uncertain must keep holding.
   */
  telemetryRequest?(url: string): boolean;
  /** CSS selectors removed from the DOM before portable artifacts are produced. */
  removeSelectors?: string[];
  /** Imperative escape hatch (wait-for-app, conditional removal). Runs AFTER
   *  removeSelectors. Best-effort: a throw is swallowed and liberation continues. */
  prepare?(page: Page, ctx: LiberationContext): Promise<void>;
  /**
   * Runs immediately before fluid learning, after source evidence was observed.
   * Replace runtime-written geometry whose relationship the platform declares
   * with that relationship as CSS, and stop the runtime rewriting it, so the
   * width sweep neither samples nor freezes it. Only declare what is proven
   * equivalent at the capture width. Best-effort: a throw is swallowed.
   */
  beforeFluid?(page: Page, ctx: LiberationContext): Promise<void>;
  /**
   * Runs after fluid learning and immediately before HTML/screenshot serialize.
   * Use this for runtime widgets that only exist on the DOM that will be frozen.
   * Best-effort: a throw is swallowed and liberation continues.
   */
  beforeSerialize?(page: Page, ctx: LiberationContext): Promise<void>;
  /**
   * Collect the image variants this platform's runtime swapped in at the
   * current viewport, as {stable media id → variant URL}.
   *
   * Platforms serve per-viewport crops from their own CDNs under their own URL
   * shapes, so recognising them is adapter knowledge. The capture path only
   * knows that a source may have viewport-specific variants worth recording;
   * it must not know what any particular CDN looks like.
   *
   * Best-effort: a throw is swallowed and liberation continues.
   */
  responsiveImages?(page: Page, ctx: LiberationContext): Promise<Record<string, string>>;
  /**
   * Rewrite a serialized HTML artifact (page HTML or a captured dialog) before
   * it is stored. Runs on the frozen string only, never on the live page, so
   * the platform runtime keeps working for later probes. Use it for
   * platform-owned identifiers that vary per route but carry no meaning in a
   * static copy. Must be deterministic and keep markup and in-document CSS
   * paired.
   */
  canonicalizeHtml?(html: string): string;
  /**
   * Selectors that identify this platform's client-error shell: the document
   * its client runtime swaps in when the app crashes (for Next.js App Router,
   * `html#__next_error__`). Capture checks each page's serialized HTML against
   * them and refuses to persist a match, reporting the route as failed instead
   * of saving the error shell as page content. Declare only selectors proven
   * to be crash shells; absent or empty checks nothing.
   */
  clientErrorShellSelectors?: string[];
}

export interface LiberationContext {
  url: string;
  viewport: string;
  /**
   * The route document exactly as the server sent it, before any script ran.
   * Undefined when the body could not be read. A platform runtime can remove
   * server-rendered markup until it is in view, so this is the evidence of
   * what the page declares, independent of what is mounted right now.
   */
  serverHtml?: string;
}
