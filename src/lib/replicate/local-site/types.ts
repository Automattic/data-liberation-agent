export type SectionRole = 'body' | 'header' | 'nav' | 'footer';

export interface LocalPage {
  /** Path relative to the site root, e.g. "index.html" or "blog/post.html". */
  relPath: string;
  /** Stable slug derived from relPath ("index.html" → "home"). */
  slug: string;
  /** Raw HTML as read from disk. */
  html: string;
  /** <title> text, trimmed; "" when absent. */
  title: string;
}

export interface LocalSite {
  root: string;
  pages: LocalPage[];
}

export interface NavLink {
  fromSlug: string;
  toSlug: string;
  label: string;
  /** True when the anchor sits inside a <nav> element — preferred for menus. */
  inNav?: boolean;
}

export interface Section {
  /** Stable, deterministic id (existing id/class, heading slug, or content hash). */
  id: string;
  role: SectionRole;
  /** outerHTML of the section element. */
  html: string;
  /** The source element's class list, in order — preserved onto the emitted
   * block wrapper so carried source CSS keeps matching (stage 1d). */
  classes?: string[];
  /** nativeBehaviors: when set, the emitter swaps the core/group wrapper for
   * the matching custom Interactivity block (dla/reveal). Section-level only;
   * chrome behaviors (sticky) ride HeaderPartOpts instead. */
  behavior?: RevealBehavior;
}

export interface NormalizeReportEntry {
  sectionId: string;
  blockType: string;
  /** 1 = clean deterministic mapping; <1 = a fallback was used. */
  confidence: number;
}

/** Detected source behavior mapped to a custom Interactivity block (Plan A catalog). */
export interface RevealBehavior {
  kind: 'reveal';
  /** IntersectionObserver threshold parsed from source JS; default 0.12. */
  threshold: number;
  /** Source animation params mirrored into the block's scoped CSS. */
  translateY: string;
  durationMs: number;
}

export interface StickyBehavior {
  kind: 'sticky';
  /** Class the source scroll listener toggles (e.g. "is-scrolled"). */
  toggleClass: string;
  /** scrollY threshold (px) parsed from source JS; default 8. */
  offset: number;
}

/** Non-catalog source JS behavior — reported, never guessed (spec §6 fallback). */
export interface BehaviorGap {
  pattern: string;
  jsExcerpt: string;
}

export interface DetectedBehaviors {
  reveal?: RevealBehavior;
  sticky?: StickyBehavior;
  gaps: BehaviorGap[];
}
