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
}

export interface NormalizeReportEntry {
  sectionId: string;
  blockType: string;
  /** 1 = clean deterministic mapping; <1 = a fallback was used. */
  confidence: number;
}
