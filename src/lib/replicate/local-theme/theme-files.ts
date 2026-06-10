// src/lib/replicate/local-theme/theme-files.ts
//
// Assemble the local-site block theme: run the REUSED buildThemeScaffold with
// a minimal default design foundation (stage 1b has no Playwright token
// capture — tokens arrive in a later stage), then post-process the file list:
// swap in the local chrome parts and add no-title page templates. Sidecar
// content carries its own <h1>, so page templates render post-content only
// (a post-title block would duplicate the hero heading).
//
// DesignFoundation is a lib-local non-exported interface in theme-scaffold.ts;
// the plain object below is structurally compatible (all fields are optional)
// so TypeScript accepts it without a cast.
//
import { buildThemeScaffold } from '../theme-scaffold.js';
import type { ReplicaFile } from '../../preview/types.js';

/** Minimal foundation — all DesignFoundation fields are optional; this sets
 *  just enough for buildThemeScaffold to emit a valid theme.json palette/font
 *  entry without choking on undefined reads. */
const DEFAULT_LOCAL_FOUNDATION = {
  color: {
    surface: { base: { value: '#ffffff' } },
    text: { default: { value: '#111111' } },
    accent: { primary: { value: '#0066cc' } },
  },
  typography: { families: { body: { value: 'system-ui, sans-serif' } } },
};

export interface AssembleLocalThemeOpts {
  siteTitle: string;
  themeSlug: string;
  headerPart: string;
  footerPart: string;
}

/** No-title page template: header part → post-content → footer part.
 *  Sidecar markup already contains its own <h1>, so wp:post-title is omitted
 *  to avoid duplicating the hero heading. Used for both page-local and
 *  front-page templates. */
function noTitleTemplate(): string {
  return (
    `<!-- wp:template-part {"slug":"header","tagName":"header"} /-->\n\n` +
    `<!-- wp:group {"tagName":"main","layout":{"type":"constrained"}} -->\n` +
    `<main class="wp-block-group">\n` +
    `<!-- wp:post-content {"layout":{"type":"constrained"}} /-->\n` +
    `</main>\n` +
    `<!-- /wp:group -->\n\n` +
    `<!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->\n`
  );
}

export function assembleLocalTheme(opts: AssembleLocalThemeOpts): ReplicaFile[] {
  const base = buildThemeScaffold({
    foundation: DEFAULT_LOCAL_FOUNDATION,
    themeSlug: opts.themeSlug,
    siteTitle: opts.siteTitle,
  });

  // Swap scaffold-generated chrome parts with the locally-built versions.
  const swapped = base.map((f) => {
    if (f.relativePath === 'parts/header.html') return { ...f, content: opts.headerPart };
    if (f.relativePath === 'parts/footer.html') return { ...f, content: opts.footerPart };
    return f;
  });

  // Register page-local as a selectable custom template so _wp_page_template
  // assignment resolves (template files alone don't appear in the dropdown).
  const withTemplates = swapped.map((f) => {
    if (f.relativePath !== 'theme.json') return f;
    const parsed = JSON.parse(f.content) as Record<string, unknown> & {
      customTemplates?: Array<{ name: string; title: string; postTypes?: string[] }>;
    };
    const customTemplates = parsed.customTemplates ?? [];
    customTemplates.push({ name: 'page-local', title: 'Local Page (no title)', postTypes: ['page'] });
    return { ...f, content: JSON.stringify({ ...parsed, customTemplates }, null, 2) };
  });

  const template = noTitleTemplate();
  // page-local: the selectable per-page template assigned via _wp_page_template.
  withTemplates.push({ relativePath: 'templates/page-local.html', content: template });
  // front-page.html: WP serves this at the site root when static front page is set;
  // same shape ensures the home page also uses the no-title layout.
  // buildThemeScaffold does NOT emit front-page.html with a minimal call (only
  // emitted when reconstructedPages has isHome: true — which this call omits),
  // so no duplicate path is introduced.
  withTemplates.push({ relativePath: 'templates/front-page.html', content: template });
  return withTemplates;
}
