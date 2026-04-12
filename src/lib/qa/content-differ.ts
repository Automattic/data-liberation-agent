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

  // Headings: check that WXR headings exist in the origin (containment direction)
  const originHeadingSet = new Set(originHeadings.map((h) => `${h.level}:${normalize(h.text)}`));
  const missingHeadings = wxr.headings.filter(
    (wh) => !originHeadingSet.has(`${wh.level}:${normalize(wh.text)}`),
  );

  // Images: check that WXR images exist in the origin (containment direction)
  const originFilenames = new Set(origin.images.map((img) => extractFilename(img.src)));
  const missingImages = wxr.images.filter(
    (img) => !originFilenames.has(extractFilename(img.src)),
  );

  // Links: check that WXR links exist in the origin (containment direction)
  const originHrefs = new Set(origin.links.map((l) => l.href));
  const missingLinks = wxr.links.filter((l) => !originHrefs.has(l.href));

  const headingsMatch = {
    origin: originHeadings.length,
    wxr: wxr.headings.length,
    missing: missingHeadings.length, // WXR headings NOT found in origin
  };
  const imagesMatch = {
    origin: origin.images.length,
    wxr: wxr.images.length,
    missing: missingImages.length, // WXR images NOT found in origin
  };
  const linksMatch = {
    origin: origin.links.length,
    wxr: wxr.links.length,
    missing: missingLinks.length, // WXR links NOT found in origin
  };

  // Grade: weighted score — text 50%, headings 20%, images 20%, links 10%
  // Scores measure containment: what fraction of WXR content is verified in origin
  const headingsScore = wxr.headings.length === 0 ? 1 : 1 - missingHeadings.length / wxr.headings.length;
  const imagesScore = wxr.images.length === 0 ? 1 : 1 - missingImages.length / wxr.images.length;
  const linksScore = wxr.links.length === 0 ? 1 : 1 - missingLinks.length / wxr.links.length;

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
