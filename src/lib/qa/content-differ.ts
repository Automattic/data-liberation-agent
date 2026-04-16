import type { ContentModel } from '../extraction/content-parser.js';

export interface ContentDiff {
  textSimilarity: number;
  headingsMatch: { origin: number; wxr: number; missing: number };
  imagesMatch: { origin: number; wxr: number; missing: number };
  linksMatch: { origin: number; wxr: number; missing: number };
  missingHeadings: ContentModel['headings'];
  missingImages: ContentModel['images'];
  missingLinks: ContentModel['links'];
  grade: 'pass' | 'warn' | 'fail';
}

/**
 * @param postTitle - If provided, the page's h1 title is excluded from heading comparison
 *   since WXR stores the title separately from content.
 */
export function diffContent(origin: ContentModel, wxr: ContentModel, postTitle?: string): ContentDiff {
  const isEmpty =
    !origin.text &&
    origin.headings.length === 0 &&
    origin.images.length === 0 &&
    origin.links.length === 0;

  // Use containment (what fraction of WXR words appear in the origin) rather
  // than Jaccard similarity. The origin page often has far more content than
  // what we extract (JS widgets, section builders, etc.), which tanks Jaccard.
  // Containment answers the right question: "is the extracted content real?"
  const textSimilarity = isEmpty ? 1 : containment(wxr.text, origin.text);

  // Filter out the post title h1 from origin headings — WXR stores it as metadata, not content
  const originHeadings = postTitle
    ? origin.headings.filter((h) => !(h.level === 1 && normalize(h.text) === normalize(postTitle)))
    : origin.headings;

  // Headings: find origin headings missing from WXR (coverage direction)
  const wxrHeadingSet = new Set(wxr.headings.map((h) => `${h.level}:${normalize(h.text)}`));
  const missingHeadings = originHeadings.filter(
    (oh) => !wxrHeadingSet.has(`${oh.level}:${normalize(oh.text)}`),
  );

  // Images: find origin images missing from WXR (coverage direction)
  const wxrFilenames = new Set(wxr.images.map((img) => extractFilename(img.src)));
  const missingImages = origin.images.filter(
    (img) => !wxrFilenames.has(extractFilename(img.src)),
  );

  // Links: find origin links missing from WXR (coverage direction)
  const wxrHrefs = new Set(wxr.links.map((l) => l.href));
  const missingLinks = origin.links.filter((l) => !wxrHrefs.has(l.href));

  const headingsMatch = {
    origin: originHeadings.length,
    wxr: wxr.headings.length,
    missing: missingHeadings.length, // origin headings NOT found in WXR
  };
  const imagesMatch = {
    origin: origin.images.length,
    wxr: wxr.images.length,
    missing: missingImages.length, // origin images NOT found in WXR
  };
  const linksMatch = {
    origin: origin.links.length,
    wxr: wxr.links.length,
    missing: missingLinks.length, // origin links NOT found in WXR
  };

  // Grade: weighted score — text 50%, headings 20%, images 20%, links 10%
  // Scores measure coverage: what fraction of origin elements were extracted
  const headingsScore = originHeadings.length === 0 ? 1 : 1 - missingHeadings.length / originHeadings.length;
  const imagesScore = origin.images.length === 0 ? 1 : 1 - missingImages.length / origin.images.length;
  const linksScore = origin.links.length === 0 ? 1 : 1 - missingLinks.length / origin.links.length;

  const overall = isEmpty
    ? 1
    : textSimilarity * 0.5 + headingsScore * 0.2 + imagesScore * 0.2 + linksScore * 0.1;

  let grade: ContentDiff['grade'];
  if (overall > 0.9) {
    grade = 'pass';
  } else if (overall >= 0.7) {
    grade = 'warn';
  } else {
    grade = 'fail';
  }

  return {
    textSimilarity,
    headingsMatch,
    imagesMatch,
    linksMatch,
    missingHeadings,
    missingImages,
    missingLinks,
    grade,
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/['']/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * What fraction of words in `subset` also appear in `superset`?
 * Returns 1.0 when every extracted word exists in the origin — meaning
 * we captured real content, even if the origin has much more.
 */
function containment(subset: string, superset: string): number {
  const subWords = wordSet(subset);
  const superWords = wordSet(superset);
  if (subWords.size === 0 && superWords.size === 0) return 1;
  if (subWords.size === 0) return 0;

  let found = 0;
  for (const w of subWords) {
    if (superWords.has(w)) found++;
  }
  return found / subWords.size;
}

function wordSet(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return new Set(words);
}

function extractFilename(url: string): string {
  try {
    const pathname = new URL(url, 'https://placeholder.invalid').pathname;
    const segments = pathname.split('/');
    return segments[segments.length - 1] || '';
  } catch {
    return url;
  }
}
