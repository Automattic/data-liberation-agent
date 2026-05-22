// src/lib/replicate/validate-artifacts.ts
//
// The pre-install gate. Pure: takes generated patterns + their specs, returns a
// structured report. THREE responsibilities:
//   1. drift      — placeholders, remote URLs, decorative comments, bad model
//   2. security   — escaping / injection allowlist (the trust boundary)
//   3. provenance — emitted text ⊆ spec captured text
//
//   patterns[] ──▶ for each: drift ✓ · security ✓ · provenance ✓ ──▶ { ok, errors[], warnings[] }
//
export const ALLOWED_INTERACTION_MODELS = new Set([
  'static', 'gallery', 'media-text', 'columns', 'cover-with-headline',
  'animated-cover', 'logo-strip', 'testimonial', 'cta', 'blog-card-grid',
  'project-card-grid', 'price-list', 'color-block-grid', 'marquee-strip',
  'horizontal-showcase', 'footer', 'nav',
]);

function decodeEntities(v: string): string {
  return v.replace(/&#8217;|&#039;|&apos;/g, "'").replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
}
function normalizeText(v: string): string {
  return decodeEntities(v.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().toLowerCase();
}
/** Visible text content of block markup, stripped of wp comments + php + tags. */
function visibleText(php: string): string {
  return normalizeText(php.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\?php[\s\S]*?\?>/g, ' '));
}

export interface PatternSpec {
  interactionModel: string;
  /** Verbatim captured text the pattern is allowed to contain. */
  expectedText: string[];
  /** Local asset paths the pattern is expected to reference. */
  expectedAssets: string[];
}
export interface ArtifactPattern { slug: string; php: string; spec: PatternSpec; }
export interface ArtifactInput { patterns: ArtifactPattern[]; }
export interface Finding { slug: string; message: string; }
export interface ValidationReport { ok: boolean; errors: Finding[]; warnings: Finding[]; }

export function validateArtifacts(input: ArtifactInput): ValidationReport {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];

  for (const p of input.patterns) {
    const fail = (message: string) => errors.push({ slug: p.slug, message });

    // --- drift ---
    if (/\{\{[A-Z0-9_ -]+\}\}/.test(p.php)) {
      fail('unresolved template placeholder remains in generated pattern');
    }
    if (/<img[^>]+https?:\/\//i.test(p.php) || /url\(\s*['"]?https?:\/\//i.test(p.php)) {
      fail('remote image URL found; route assets through get_theme_file_uri()');
    }
    for (const comment of p.php.matchAll(/<!--([\s\S]*?)-->/g)) {
      const body = comment[1].trim();
      if (body.startsWith('wp:') || body.startsWith('/wp:')) continue;
      fail(`non-WordPress HTML comment found: "${body.slice(0, 80)}"`);
    }
    if (!ALLOWED_INTERACTION_MODELS.has(p.spec.interactionModel)) {
      fail(`invalid or missing interaction model "${p.spec.interactionModel || '(empty)'}"`);
    }

    // --- security: injection / XSS trust boundary ---
    // The ONLY permitted PHP is the sanctioned theme-asset echo. Anything else
    // is treated as injection (defends builder prompt-injection via source text).
    const SANCTIONED_PHP = /<\?php\s+echo\s+esc_url\(\s*get_theme_file_uri\(\s*'[^']+'\s*\)\s*\);\s*\?>/g;
    const residualPhp = p.php.replace(SANCTIONED_PHP, '');
    if (/<\?php|<\?=/.test(residualPhp)) {
      fail('raw PHP tag in markup (only esc_url(get_theme_file_uri()) is allowed)');
    }
    if (/<script[\s>]/i.test(p.php)) {
      fail('raw <script> tag in markup (not allowed)');
    }
    if (/\son[a-z]+\s*=/i.test(p.php)) {
      fail('inline event handler attribute (on*=) in markup (not allowed)');
    }

    // --- provenance: emitted text must be a subset of spec.expectedText ---
    const allowed = normalizeText(p.spec.expectedText.join(' '));
    const emitted = visibleText(p.php);
    for (const word of emitted.split(' ').filter((w) => w.length > 3)) {
      if (!allowed.includes(word)) {
        warnings.push({ slug: p.slug, message: `possible non-source content: "${word}"` });
      }
    }
    for (const heading of p.php.matchAll(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/gi)) {
      const h = normalizeText(heading[1]);
      if (h && !allowed.includes(h)) {
        fail(`heading "${heading[1].trim()}" not found in source spec (provenance)`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
