// src/lib/replicate/section-extract.ts
//
// Classify decision tree for each semantic landmark:
//
//   landmark element
//       │
//       ├─ has heading (h1–h6) AND button-like (button | a[class*=button] | [class*=btn])
//       │   └─▶ type: 'cover-with-headline'
//       │
//       ├─ has ≥3 sibling children whose class contains 'col'
//       │   └─▶ type: 'columns'  (columns = count)
//       │
//       ├─ has ≥4 <img> AND text-to-img ratio is low
//       │   └─▶ type: 'gallery'
//       │
//       └─ (default)
//           └─▶ type: 'static'
//
// extractSignature runs entirely off saved HTML — no browser, no Playwright.
// Uses cheerio (already in package.json) for DOM traversal.
// extractFull (Playwright computed-styles path) is DEFERRED to a later sub-plan.

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type { PageSignature, SectionSignature } from './page-signature.js';

const LANDMARK_SELECTOR = 'section, header, footer, nav, main, article';

function classifyLandmark($: CheerioAPI, el: Element): SectionSignature {
  const $el = $(el);

  // 1. cover-with-headline: has a heading AND a button-like element
  const hasHeading = $el.find('h1,h2,h3,h4,h5,h6').length > 0;
  const hasButton =
    $el.find('button').length > 0 ||
    $el.find('a').filter((_i, a) => {
      const cls = $(a).attr('class') ?? '';
      return /\bbtn\b|\bbutton\b/i.test(cls);
    }).length > 0 ||
    $el.find('[class]').filter((_i, node) => {
      const cls = $(node).attr('class') ?? '';
      return /\bbtn\b|\bbutton\b/i.test(cls);
    }).length > 0;

  if (hasHeading && hasButton) {
    return { type: 'cover-with-headline' };
  }

  // 2. columns: ≥3 direct children (or descendants) with class containing 'col'
  const colChildren = $el.children().filter((_i, child) => {
    const cls = $(child).attr('class') ?? '';
    return /\bcol\b/i.test(cls) || /\bcol-/i.test(cls);
  });
  if (colChildren.length >= 3) {
    return { type: 'columns', columns: colChildren.length };
  }

  // 3. gallery: ≥4 <img> with low surrounding text
  const imgCount = $el.find('img').length;
  if (imgCount >= 4) {
    const text = ($el.text() ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < imgCount * 40) {
      return { type: 'gallery', imageBucket: imgCount >= 8 ? 'many' : 'few' };
    }
  }

  // 4. default
  return { type: 'static' };
}

export function extractSignature(url: string, html: string, htmlBytes: number): PageSignature {
  const $ = cheerio.load(html);

  // Collect top-level landmark elements in document order.
  // "Top-level" means we skip landmarks that are nested inside another landmark.
  const landmarks: Element[] = [];
  $(LANDMARK_SELECTOR).each((_i, el) => {
    // Walk ancestors; if any ancestor is also a landmark, skip this element.
    let ancestor = el.parent;
    let nested = false;
    while (ancestor && ancestor.type === 'tag') {
      const tag = (ancestor as Element).tagName?.toLowerCase() ?? '';
      if (['section', 'header', 'footer', 'nav', 'main', 'article'].includes(tag)) {
        nested = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!nested) {
      landmarks.push(el);
    }
  });

  // Fallback: no landmarks → single static section
  if (landmarks.length === 0) {
    return { url, htmlBytes, sections: [{ type: 'static' }] };
  }

  const sections: SectionSignature[] = landmarks.map((el) => classifyLandmark($, el));
  return { url, htmlBytes, sections };
}
