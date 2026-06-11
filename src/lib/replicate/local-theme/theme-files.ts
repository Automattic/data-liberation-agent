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
import type { LocalFontFace } from '../font-capture.js';

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

export interface CarrySourceAssets {
  /** Compat layer + adapted source CSS (from collectSourceAssets). Empty string = no CSS carry. */
  css: string;
  /** Source JS concatenated (from collectSourceAssets). Empty string = no JS carry. */
  js: string;
}

export interface AssembleLocalThemeOpts {
  siteTitle: string;
  themeSlug: string;
  headerPart: string;
  footerPart: string;
  /** Captured design foundation (from buildLocalFoundation). Defaults to the minimal foundation. */
  foundation?: Parameters<typeof buildThemeScaffold>[0]['foundation'];
  /** Self-hosted fonts captured from the source site — emitted as @font-face + theme.json fontFamilies. */
  capturedFonts?: LocalFontFace[];
  /** Stage 1d: carry the source site's CSS/JS into the theme. When set and css is
   * non-empty, theme.json `styles` is stripped (source CSS is the design authority;
   * settings stay for editor pickers). Each asset file is written only when non-empty. */
  carrySourceAssets?: CarrySourceAssets;
  /** Source body data-* attributes per permalink pathname (keys WITHOUT the
   * data- prefix). Replayed by a wp_body_open shim before any deferred script
   * runs — JS-rendered sites key behavior off them (body[data-page] active
   * nav). Emitted only inside the carry block (the attrs matter to carried
   * source JS). */
  bodyDataByPath?: Record<string, Record<string, string>>;
}

/** No-title page template: header part → post-content → footer part.
 *  Sidecar markup already contains its own <h1>, so wp:post-title is omitted
 *  to avoid duplicating the hero heading. Used for both page-local and
 *  front-page templates. Layout is default (flow) — constrained would inject
 *  a contentSize max-width onto children that fights the carried source
 *  main{max-width} rule (stage 1d parity); the source CSS owns layout. */
function noTitleTemplate(): string {
  return (
    `<!-- wp:template-part {"slug":"header","tagName":"header"} /-->\n\n` +
    `<!-- wp:group {"tagName":"main"} -->\n` +
    `<main class="wp-block-group">\n` +
    `<!-- wp:post-content /-->\n` +
    `</main>\n` +
    `<!-- /wp:group -->\n\n` +
    `<!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->\n`
  );
}

/** functions.php block appended in carry mode — enqueue source assets after
 * the theme stylesheet + global styles, and add the html.js gate the source
 * reveal scripts expect. Priority 20 ensures it lands AFTER the default
 * wp_enqueue_scripts (10) and global styles injected by the block editor.
 *
 * The html.js gate is emitted ONLY when source JS is actually carried
 * (emitHtmlJsGate): reveal-gated source CSS hides sections behind html.js
 * and relies on a source script (observer) to reveal them — adding the class
 * with no script present would leave that content permanently hidden. */
function carryEnqueueBlock(
  themeSlug: string,
  emitHtmlJsGate: boolean,
  bodyDataByPath?: Record<string, Record<string, string>>,
): string {
  const htmlJsBlock = emitHtmlJsGate
    ? `
// Source reveal scripts gate on html.js (no-JS visitors keep content visible).
add_action( 'wp_head', function () {
    echo "<script>document.documentElement.classList.add('js');</script>";
}, 0 );
`
    : '';
  // Replay the SOURCE body data-* attributes (keys stored bare) by pathname,
  // at wp_body_open — before any deferred script runs — so carried source JS
  // that keys off body[data-*] (active-nav, page modes) behaves identically.
  // JSON is <-escaped so no value can close the script tag.
  const bodyDataBlock =
    bodyDataByPath && Object.keys(bodyDataByPath).length > 0
      ? `
// JS-rendered source: replay body data-* attributes per pathname.
add_action( 'wp_body_open', function () {
    echo '<script>(function(){var m=${JSON.stringify(bodyDataByPath).replace(/</g, '\\u003c').replace(/'/g, "\\'")};var d=m[location.pathname];if(d){for(var k in d){document.body.setAttribute("data-"+k,d[k]);}}})();</script>';
} );
`
      : '';
  return `
// Stage 1d carry: the source site's own CSS/JS, adapted for the block DOM.
// Enqueued at priority 20 so it lands AFTER global styles + theme style.
// Guards are @filemtime (not file_exists): PHP's realpath cache keeps
// file_exists() TRUE for up to 120s after a deletion while the stat fails,
// and the bare filemtime() printed a warning INTO the served page. One
// suppressed stat is the truthful existence check AND the enqueue version.
add_action( 'wp_enqueue_scripts', function () {
    $css = get_theme_file_path( 'assets/css/source.css' );
    $css_mtime = @filemtime( $css );
    if ( false !== $css_mtime ) {
        wp_enqueue_style( '${themeSlug}-source', get_theme_file_uri( 'assets/css/source.css' ), array( '${themeSlug}-style' ), (string) $css_mtime );
    }
    $js = get_theme_file_path( 'assets/js/source.js' );
    $js_mtime = @filemtime( $js );
    if ( false !== $js_mtime ) {
        wp_enqueue_script( '${themeSlug}-source', get_theme_file_uri( 'assets/js/source.js' ), array(), (string) $js_mtime, true );
    }
    $patch = get_theme_file_path( 'assets/css/parity-patch.css' );
    $patch_mtime = @filemtime( $patch );
    if ( false !== $patch_mtime ) {
        $deps = false !== $css_mtime ? array( '${themeSlug}-source' ) : array( '${themeSlug}-style' );
        wp_enqueue_style( '${themeSlug}-parity-patch', get_theme_file_uri( 'assets/css/parity-patch.css' ), $deps, (string) $patch_mtime );
    }
}, 20 );
${htmlJsBlock}${bodyDataBlock}`;
}

export function assembleLocalTheme(opts: AssembleLocalThemeOpts): ReplicaFile[] {
  // NOTE: buildThemeScaffold's footerBgToken/footerTextToken opts are NOT
  // passed here — they only style the scaffold's OWN parts/footer.html, which
  // we unconditionally swap with opts.footerPart below. Footer band styling
  // belongs in buildFooterPart (chrome-parts.ts bgToken/textToken).
  const base = buildThemeScaffold({
    foundation: opts.foundation ?? DEFAULT_LOCAL_FOUNDATION,
    themeSlug: opts.themeSlug,
    siteTitle: opts.siteTitle,
    capturedFonts: opts.capturedFonts,
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
    const customTemplates = [
      ...(parsed.customTemplates ?? []),
      { name: 'page-local', title: 'Local Page (no title)', postTypes: ['page'] },
    ];
    // Trailing newline matches the scaffold's theme.json emit convention.
    return { ...f, content: JSON.stringify({ ...parsed, customTemplates }, null, 2) + '\n' };
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

  // Stage 1d carry: wire source CSS/JS into the theme so the class-preserving
  // block DOM renders under the designer's own stylesheet.
  if (opts.carrySourceAssets) {
    const { css, js } = opts.carrySourceAssets;
    const hasCSS = css.trim().length > 0;
    const hasJS = js.trim().length > 0;

    // 1. Strip theme.json styles — source CSS is the design authority. Strip
    //    ONLY when CSS is non-empty: if only JS is carried the token-based
    //    styles remain the layout layer. Trailing newline preserved (convention).
    if (hasCSS) {
      const idx = withTemplates.findIndex((f) => f.relativePath === 'theme.json');
      if (idx >= 0) {
        const parsed = JSON.parse(withTemplates[idx].content) as Record<string, unknown> & {
          settings?: Record<string, unknown> & { spacing?: Record<string, unknown> };
        };
        delete parsed.styles;
        // blockGap:null disables WP's layout-support emission wholesale —
        // the injected :where(.is-layout-flow) child margin-zeroing + uniform
        // gap rules override the UA-default margins the source rhythm relies
        // on (probe: replica h1 margin-bottom forced to 0). Layout supports
        // apply flow by DEFAULT even with no layout attr, so this is the only
        // reliable off switch.
        parsed.settings = { ...(parsed.settings ?? {}), spacing: { ...(parsed.settings?.spacing ?? {}), blockGap: null } };
        withTemplates[idx] = { ...withTemplates[idx], content: JSON.stringify(parsed, null, 2) + '\n' };
      }
    }

    // 2. Emit asset files — each file only when its content is non-empty.
    if (hasCSS) {
      withTemplates.push({ relativePath: 'assets/css/source.css', content: css });
    }
    if (hasJS) {
      withTemplates.push({ relativePath: 'assets/js/source.js', content: js });
    }

    // 3. Append the enqueue block to functions.php (@filemtime guards make
    //    it safe even when only one of the two assets is non-empty). The
    //    html.js gate ships only alongside actual source JS (hasJS).
    const fIdx = withTemplates.findIndex((f) => f.relativePath === 'functions.php');
    if (fIdx >= 0) {
      withTemplates[fIdx] = {
        ...withTemplates[fIdx],
        content: withTemplates[fIdx].content + carryEnqueueBlock(opts.themeSlug, hasJS, opts.bodyDataByPath),
      };
    }
  }

  return withTemplates;
}
